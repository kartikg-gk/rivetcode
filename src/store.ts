import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertId, assertProjectId, branchName } from "./paths.js";
import { ACTIVITY_STATES, AGENTS, PR_STATUSES, ROLES, type ActivityState, type Node, type Role } from "./model.js";

// One agent session working on one task in its own worktree.
export type Run = {
  id: string;
  project: string;
  repo: string;
  base: string;
  task: string;
  createdAt: string;
  role: Role;
  // A short label for lists ("fix login"); empty when none was given.
  name: string;
  // The orchestrator session that started this worker, if any; its reports go there.
  orchestrator?: string;
  // The model asked for when it was started; otherwise the project's worker.model.
  model?: string;
  // The issue the task came from, in the run's own repository; its pull request closes it.
  issue?: number;
  node: Node;
};

export type Store = {
  saveRun(run: Run): void;
  loadRun(runId: string): Run;
  listRuns(project?: string): string[];
  // state null keeps the current activity (a hook that only reports the agent's own session id).
  setActivity(runId: string, nodeId: string, state: ActivityState | null, agentSessionId?: string): boolean;
  // A hook from the agent itself: activity, the first-signal time for this launch, and the
  // agent's conversation id (kept for every launch, so usage counts retries too).
  recordSignal(runId: string, nodeId: string, state: ActivityState | null, agentSessionId?: string): boolean;
  // A launch: idle until the agent's hooks say otherwise; it must prove its signal again.
  markLaunched(runId: string, nodeId: string): void;
  // Every agent conversation a run's nodes have had.
  conversations(runId: string): { nodeId: string; agent: string; id: string }[];
  createReport(runId: string, nodeId: string, kind: "done" | "stuck" | "needs-input", message?: string): number | null;
  queueMessage(runId: string, nodeId: string, message: string, from?: string): number | null;
  undeliveredMessages(runId: string, nodeId: string): { id: number; message: string }[];
  markDelivered(id: number): void;
  // After a daemon restart no agent is running; returns how many nodes were changed.
  exitStaleSessions(): number;
  // Changes some fields of one node in place; null clears an optional field.
  updateNode(runId: string, nodeId: string, fields: NodeUpdate): void;
  // Per-project settings such as the check and test commands.
  getConfig(project: string): Record<string, string>;
  setConfig(project: string, key: string, value: string | null): void;
  // A run's pull request; "handled" remembers which feedback was already acted on.
  getPr(runId: string): PullRequest | null;
  setPr(runId: string, pr: PullRequest): void;
  // Review passes over a run's pull request, oldest first.
  startReview(runId: string, sha: string, trigger: Review["trigger"]): number;
  endReview(id: number, fields: { status: "complete" | "failed"; verdict?: Review["verdict"]; body?: string; githubReviewId?: number }): void;
  reviewsOf(runId: string): Review[];
  // A project's cues, by name.
  saveCue(cue: Cue): void;
  listCues(project: string): Cue[];
  deleteCue(project: string, name: string): boolean;
  // Whether the run ends (agents stopped, worktrees removed) once its pull request merges.
  getTerminateOnPrMerge(runId: string): boolean;
  setTerminateOnPrMerge(runId: string, terminate: boolean): void;
  close(): void;
};

export type PullRequest = { number: number; url: string; handled?: string };

// One review pass over a worker's pull request at one commit.
export type Review = {
  id: number;
  runId: string;
  sha: string;
  // auto: Rivet started it after the pull request opened or changed; manual: rivet review.
  trigger: "auto" | "manual";
  status: "running" | "complete" | "failed";
  verdict?: "approved" | "changes_requested";
  body?: string;
  githubReviewId?: number;
  createdAt: string;
};

// A saved prompt or command of a project, run by name.
export type Cue = {
  project: string;
  name: string;
  // agent: a prompt for an agent; command: a shell command run in a terminal.
  type: "agent" | "command";
  text: string;
  updatedAt: string;
};

export type NodeUpdate = {
  status?: Node["status"];
  attempts?: number;
  summary?: string | null;
  finishedAt?: string | null;
  // The task the session works on.
  prompt?: string;
  // Where the root's pull request stands.
  prStatus?: Node["prStatus"] | null;
};

const UPDATE_COLUMNS: Record<keyof NodeUpdate, string> = {
  status: "status", attempts: "attempts", summary: "summary", finishedAt: "finished_at", prompt: "prompt", prStatus: "pr_status",
};

export class RunStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStoreError";
  }
}

export function newRunId(now: number = Date.now()): string {
  const rand = randomBytes(4).readUInt32BE(0).toString(36).padStart(4, "0").slice(-4);
  return `r${now.toString(36)}${rand}`;
}

const oneOf = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

// The lists the early migrations were written with. Shipped migrations never change, so
// these stay as they were even though runs now use fewer of them.
const KINDS = ["leaf", "parent"] as const;
const STATUSES = ["pending", "running", "waiting", "integrating", "done", "failed", "escalated", "skipped"] as const;

// Numbered schema changes, applied in order and recorded once each. Never edit a
// shipped migration; add the next number instead.
const MIGRATIONS: { version: number; sql: string }[] = [];

const INIT = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  repo TEXT NOT NULL,
  base TEXT NOT NULL,
  task TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  kind TEXT NOT NULL CHECK (kind IN (${oneOf(KINDS)})),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  files TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN (${oneOf(AGENTS)})),
  branch TEXT NOT NULL,
  worktree TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${oneOf(STATUSES)})),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  summary TEXT,
  activity TEXT CHECK (activity IS NULL OR activity IN (${oneOf(ACTIVITY_STATES)})),
  pr_status TEXT CHECK (pr_status IS NULL OR pr_status IN (${oneOf(PR_STATUSES)})),
  PRIMARY KEY (run_id, id)
);
`;
MIGRATIONS.push({ version: 1, sql: INIT });
MIGRATIONS.push({ version: 2, sql: `
ALTER TABLE nodes ADD COLUMN agent_session_id TEXT;
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('done', 'stuck', 'needs-input')),
  message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  from_session TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
` });

// SQLite cannot change a CHECK constraint in place, so the nodes table is rebuilt:
// adds the "waiting" status and the "fake" agent, plus when a node last showed
// activity and when a leaf finished (a finished leaf waits for its parent to merge it).
MIGRATIONS.push({ version: 3, sql: `
CREATE TABLE nodes_v3 (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  kind TEXT NOT NULL CHECK (kind IN (${oneOf(KINDS)})),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  files TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN (${oneOf(AGENTS)})),
  branch TEXT NOT NULL,
  worktree TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${oneOf(STATUSES)})),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  summary TEXT,
  activity TEXT CHECK (activity IS NULL OR activity IN (${oneOf(ACTIVITY_STATES)})),
  pr_status TEXT CHECK (pr_status IS NULL OR pr_status IN (${oneOf(PR_STATUSES)})),
  agent_session_id TEXT,
  activity_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, id)
);
INSERT INTO nodes_v3 (run_id, id, position, parent_id, depth, kind, title, prompt, files, agent, branch,
  worktree, status, attempts, summary, activity, pr_status, agent_session_id)
SELECT run_id, id, position, parent_id, depth, kind, title, prompt, files, agent, branch,
  worktree, status, attempts, summary, activity, pr_status, agent_session_id FROM nodes;
DROP TABLE nodes;
ALTER TABLE nodes_v3 RENAME TO nodes;
CREATE TABLE project_config (
  project TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (project, key)
);
` });

// The pull request a run's root opened, and the last feedback Rivet already acted on.
MIGRATIONS.push({ version: 4, sql: `
CREATE TABLE pull_requests (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  handled TEXT
);
` });

// Per-run merge policy; off unless the user turns it on for that run.
MIGRATIONS.push({ version: 5, sql: `
ALTER TABLE runs ADD COLUMN terminate_on_pr_merge INTEGER NOT NULL DEFAULT 0 CHECK (terminate_on_pr_merge IN (0, 1));
` });

// When a node first started, the first hook of its current launch, and every agent
// conversation a node has had (one per launch, plus conflict fixes on parents).
MIGRATIONS.push({ version: 6, sql: `
ALTER TABLE nodes ADD COLUMN started_at TEXT;
ALTER TABLE nodes ADD COLUMN first_signal_at TEXT;
CREATE TABLE conversations (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id, conversation_id)
);
` });

// The files a parent wires after merging its children.
MIGRATIONS.push({ version: 7, sql: `
ALTER TABLE nodes ADD COLUMN shared TEXT NOT NULL DEFAULT '[]';
` });

// A run is one session now: its role, a label, and the orchestrator that started it.
MIGRATIONS.push({ version: 8, sql: `
ALTER TABLE runs ADD COLUMN role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN (${oneOf(ROLES)}));
ALTER TABLE runs ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN orchestrator TEXT;
ALTER TABLE runs ADD COLUMN model TEXT;
` });

// The issue a run's task came from.
MIGRATIONS.push({ version: 9, sql: `
ALTER TABLE runs ADD COLUMN issue INTEGER;
` });

// Saved prompts and commands per project.
MIGRATIONS.push({ version: 11, sql: `
CREATE TABLE cues (
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('agent', 'command')),
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project, name)
);
` });

// Review passes by a reviewer agent.
MIGRATIONS.push({ version: 10, sql: `
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  verdict TEXT CHECK (verdict IN ('approved', 'changes_requested')),
  body TEXT,
  github_review_id INTEGER,
  created_at TEXT NOT NULL
);
` });

function migrate(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  const record = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      record.run(m.version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new RunStoreError(`schema migration ${m.version} failed: ${(e as Error).message}`);
    }
  }
}

type RunRow = {
  id: string; project: string; repo: string; base: string; task: string; created_at: string;
  role: string; name: string; orchestrator: string | null; model: string | null; issue: number | null;
};
type NodeRow = {
  id: string; parent_id: string | null; depth: number; kind: string; title: string; prompt: string;
  files: string; agent: string; branch: string; worktree: string; status: string; attempts: number;
  summary: string | null; activity: string | null; agent_session_id: string | null; pr_status: string | null;
  activity_at: string | null; finished_at: string | null; started_at: string | null; first_signal_at: string | null;
  shared: string;
};

// One database for all projects. The daemon is meant to be its only writer.
export function openStore(data: string): Store {
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "rivet.db"));
  // WAL lets readers run beside the writer; busy_timeout absorbs brief contention.
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;",
  );
  migrate(db);

  const upsertRun = db.prepare(`
    INSERT INTO runs (id, project, repo, base, task, created_at, role, name, orchestrator, model, issue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET project = excluded.project, repo = excluded.repo,
      base = excluded.base, task = excluded.task, created_at = excluded.created_at,
      role = excluded.role, name = excluded.name, orchestrator = excluded.orchestrator, model = excluded.model, issue = excluded.issue`);
  const deleteNodes = db.prepare("DELETE FROM nodes WHERE run_id = ?");
  const insertNode = db.prepare(`
    INSERT INTO nodes (run_id, id, position, parent_id, depth, kind, title, prompt, files, agent,
      branch, worktree, status, attempts, summary, activity, pr_status, agent_session_id, activity_at, finished_at,
      started_at, first_signal_at, shared)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const selectRun = db.prepare("SELECT * FROM runs WHERE id = ?");
  const selectNodes = db.prepare("SELECT * FROM nodes WHERE run_id = ? ORDER BY position");
  const updateActivity = db.prepare(`UPDATE nodes SET activity = COALESCE(?, activity),
    activity_at = CASE WHEN ? IS NULL THEN activity_at ELSE ? END,
    agent_session_id = COALESCE(?, agent_session_id)
    WHERE run_id = ? AND id = ?`);
  const selectConfig = db.prepare("SELECT key, value FROM project_config WHERE project = ? ORDER BY key");
  const upsertConfig = db.prepare(`INSERT INTO project_config (project, key, value) VALUES (?, ?, ?)
    ON CONFLICT (project, key) DO UPDATE SET value = excluded.value`);
  const deleteConfig = db.prepare("DELETE FROM project_config WHERE project = ? AND key = ?");
  const sessionExists = db.prepare("SELECT 1 FROM nodes WHERE run_id = ? AND id = ?");
  const insertReport = db.prepare(`INSERT INTO reports (run_id, node_id, kind, message, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const insertMessage = db.prepare(`INSERT INTO outbox (run_id, node_id, from_session, message, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const selectUndelivered = db.prepare(`SELECT id, message FROM outbox
    WHERE run_id = ? AND node_id = ? AND delivered_at IS NULL ORDER BY id`);
  const updateDelivered = db.prepare("UPDATE outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
  const updateSignal = db.prepare(`UPDATE nodes SET activity = COALESCE(?, activity),
    activity_at = CASE WHEN ? IS NULL THEN activity_at ELSE ? END,
    agent_session_id = COALESCE(?, agent_session_id),
    first_signal_at = COALESCE(first_signal_at, ?)
    WHERE run_id = ? AND id = ?`);
  const insertConversation = db.prepare(`INSERT INTO conversations (run_id, node_id, agent, conversation_id, seen_at)
    SELECT run_id, id, agent, ?, ? FROM nodes WHERE run_id = ? AND id = ?
    ON CONFLICT DO NOTHING`);
  const updateLaunched = db.prepare(`UPDATE nodes SET activity = 'idle', activity_at = ?, first_signal_at = NULL,
    started_at = COALESCE(started_at, ?) WHERE run_id = ? AND id = ?`);
  const selectConversations = db.prepare(`SELECT node_id, agent, conversation_id FROM conversations
    WHERE run_id = ? ORDER BY seen_at, node_id`);
  const updateStale = db.prepare("UPDATE nodes SET activity = 'exited' WHERE activity IS NOT NULL AND activity <> 'exited'");

  function check(run: Run): void {
    assertId("run", run.id);
    assertProjectId(run.project);
    assertId("node", run.node.id);
    // Later steps run git on this branch, so it must be the node's own.
    if (run.node.branch !== branchName(run.id, run.node.id)) {
      throw new RunStoreError(`run ${run.id} has unexpected branch ${run.node.branch}`);
    }
  }

  return {
    saveRun(run) {
      try {
        check(run);
      } catch (e) {
        throw e instanceof RunStoreError ? e : new RunStoreError((e as Error).message);
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        upsertRun.run(run.id, run.project, run.repo, run.base, run.task, run.createdAt, run.role, run.name, run.orchestrator ?? null, run.model ?? null, run.issue ?? null);
        deleteNodes.run(run.id);
        const n = run.node;
        // The position, parent, depth, kind, files and shared columns are left from runs that
        // had several nodes; a one-node run fills them with their neutral values.
        insertNode.run(
          run.id, n.id, 0, null, 0, "leaf", n.title, n.prompt,
          "[]", n.agent, n.branch, n.worktree, n.status, n.attempts,
          n.summary ?? null, n.activity ?? null, n.prStatus ?? null, n.agentSessionId ?? null,
          n.activityAt ?? null, n.finishedAt ?? null, n.startedAt ?? null, n.firstSignalAt ?? null,
          "[]",
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw new RunStoreError(`could not save run ${run.id}: ${(e as Error).message}`);
      }
    },

    loadRun(runId) {
      const r = selectRun.get(runId) as RunRow | undefined;
      if (!r) throw new RunStoreError(`no run ${runId}`);
      // A run saved with several nodes reads as its first one.
      const nodes = (selectNodes.all(runId) as NodeRow[]).map((n): Node => ({
        id: n.id,
        title: n.title,
        prompt: n.prompt,
        agent: n.agent as Node["agent"],
        branch: n.branch,
        worktree: n.worktree,
        status: n.status as Node["status"],
        attempts: n.attempts,
        ...(n.summary !== null ? { summary: n.summary } : {}),
        ...(n.activity !== null ? { activity: n.activity as Node["activity"] } : {}),
        ...(n.agent_session_id !== null ? { agentSessionId: n.agent_session_id } : {}),
        ...(n.pr_status !== null ? { prStatus: n.pr_status as Node["prStatus"] } : {}),
        ...(n.activity_at !== null ? { activityAt: n.activity_at } : {}),
        ...(n.finished_at !== null ? { finishedAt: n.finished_at } : {}),
        ...(n.started_at !== null ? { startedAt: n.started_at } : {}),
        ...(n.first_signal_at !== null ? { firstSignalAt: n.first_signal_at } : {}),
      }));
      if (!nodes[0]) throw new RunStoreError(`run ${runId} has no session`);
      return {
        id: r.id, project: r.project, repo: r.repo, base: r.base, task: r.task,
        createdAt: r.created_at, role: r.role as Role, name: r.name,
        ...(r.orchestrator !== null ? { orchestrator: r.orchestrator } : {}),
        ...(r.model !== null ? { model: r.model } : {}),
        ...(r.issue !== null ? { issue: Number(r.issue) } : {}),
        node: nodes[0],
      };
    },

    listRuns(project) {
      const rows = (project === undefined
        ? db.prepare("SELECT id FROM runs ORDER BY id").all()
        : db.prepare("SELECT id FROM runs WHERE project = ? ORDER BY id").all(project)) as { id: string }[];
      return rows.map((r) => r.id);
    },

    setActivity(runId, nodeId, state, agentSessionId) {
      const now = state === null ? null : new Date().toISOString();
      return updateActivity.run(state, now, now, agentSessionId ?? null, runId, nodeId).changes > 0;
    },

    recordSignal(runId, nodeId, state, agentSessionId) {
      const now = new Date().toISOString();
      const at = state === null ? null : now;
      const found = updateSignal.run(state, at, at, agentSessionId ?? null, now, runId, nodeId).changes > 0;
      if (found && agentSessionId) insertConversation.run(agentSessionId, now, runId, nodeId);
      return found;
    },

    markLaunched(runId, nodeId) {
      const now = new Date().toISOString();
      updateLaunched.run(now, now, runId, nodeId);
    },

    conversations(runId) {
      return (selectConversations.all(runId) as { node_id: string; agent: string; conversation_id: string }[])
        .map((r) => ({ nodeId: r.node_id, agent: r.agent, id: r.conversation_id }));
    },

    createReport(runId, nodeId, kind, message) {
      if (!sessionExists.get(runId, nodeId)) return null;
      return Number(insertReport.run(runId, nodeId, kind, message ?? null, new Date().toISOString()).lastInsertRowid);
    },

    queueMessage(runId, nodeId, message, from) {
      if (!sessionExists.get(runId, nodeId)) return null;
      return Number(insertMessage.run(runId, nodeId, from ?? null, message, new Date().toISOString()).lastInsertRowid);
    },

    undeliveredMessages(runId, nodeId) {
      return (selectUndelivered.all(runId, nodeId) as { id: number; message: string }[])
        .map((r) => ({ id: Number(r.id), message: r.message }));
    },

    markDelivered(id) {
      updateDelivered.run(new Date().toISOString(), id);
    },

    exitStaleSessions() {
      return Number(updateStale.run().changes);
    },

    updateNode(runId, nodeId, fields) {
      const keys = (Object.keys(fields) as (keyof NodeUpdate)[]).filter((k) => fields[k] !== undefined);
      if (keys.length === 0) return;
      const sql = `UPDATE nodes SET ${keys.map((k) => `${UPDATE_COLUMNS[k]} = ?`).join(", ")} WHERE run_id = ? AND id = ?`;
      const changed = db.prepare(sql).run(...keys.map((k) => fields[k] as string | number | null), runId, nodeId).changes;
      if (changed === 0) throw new RunStoreError(`no node ${nodeId} in run ${runId}`);
    },

    saveCue(cue) {
      db.prepare(`INSERT INTO cues (project, name, type, text, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (project, name) DO UPDATE SET type = excluded.type, text = excluded.text, updated_at = excluded.updated_at`)
        .run(cue.project, cue.name, cue.type, cue.text, cue.updatedAt);
    },

    listCues(project) {
      type Row = { project: string; name: string; type: Cue["type"]; text: string; updated_at: string };
      return (db.prepare("SELECT * FROM cues WHERE project = ? ORDER BY name").all(project) as Row[])
        .map((r) => ({ project: r.project, name: r.name, type: r.type, text: r.text, updatedAt: r.updated_at }));
    },

    deleteCue(project, name) {
      return db.prepare("DELETE FROM cues WHERE project = ? AND name = ?").run(project, name).changes > 0;
    },

    startReview(runId, sha, trigger) {
      return Number(db.prepare("INSERT INTO reviews (run_id, sha, trigger, status, created_at) VALUES (?, ?, ?, 'running', ?)")
        .run(runId, sha, trigger, new Date().toISOString()).lastInsertRowid);
    },

    endReview(id, f) {
      db.prepare("UPDATE reviews SET status = ?, verdict = ?, body = ?, github_review_id = ? WHERE id = ? AND status = 'running'")
        .run(f.status, f.verdict ?? null, f.body ?? null, f.githubReviewId ?? null, id);
    },

    reviewsOf(runId) {
      type Row = { id: number; run_id: string; sha: string; trigger: Review["trigger"]; status: Review["status"]; verdict: Review["verdict"] | null;
        body: string | null; github_review_id: number | null; created_at: string };
      return (db.prepare("SELECT * FROM reviews WHERE run_id = ? ORDER BY id").all(runId) as Row[]).map((r) => ({
        id: Number(r.id), runId: r.run_id, sha: r.sha, trigger: r.trigger, status: r.status, createdAt: r.created_at,
        ...(r.verdict !== null ? { verdict: r.verdict } : {}), ...(r.body !== null ? { body: r.body } : {}),
        ...(r.github_review_id !== null ? { githubReviewId: Number(r.github_review_id) } : {}),
      }));
    },

    getPr(runId) {
      const row = db.prepare("SELECT number, url, handled FROM pull_requests WHERE run_id = ?").get(runId) as
        { number: number; url: string; handled: string | null } | undefined;
      if (!row) return null;
      return { number: Number(row.number), url: row.url, ...(row.handled !== null ? { handled: row.handled } : {}) };
    },

    setPr(runId, pr) {
      db.prepare(`INSERT INTO pull_requests (run_id, number, url, handled) VALUES (?, ?, ?, ?)
        ON CONFLICT (run_id) DO UPDATE SET number = excluded.number, url = excluded.url, handled = excluded.handled`)
        .run(runId, pr.number, pr.url, pr.handled ?? null);
    },

    getTerminateOnPrMerge(runId) {
      const row = db.prepare("SELECT terminate_on_pr_merge AS t FROM runs WHERE id = ?").get(runId) as { t: number } | undefined;
      return Number(row?.t ?? 0) === 1;
    },

    setTerminateOnPrMerge(runId, terminate) {
      const changed = db.prepare("UPDATE runs SET terminate_on_pr_merge = ? WHERE id = ?").run(terminate ? 1 : 0, runId).changes;
      if (Number(changed) === 0) throw new RunStoreError(`unknown run ${runId}`);
    },

    getConfig(project) {
      return Object.fromEntries((selectConfig.all(project) as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    },

    setConfig(project, key, value) {
      assertProjectId(project);
      if (value === null) deleteConfig.run(project, key);
      else upsertConfig.run(project, key, value);
    },

    close() {
      db.close();
    },
  };
}
