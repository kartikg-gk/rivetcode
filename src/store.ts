import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertId, assertProjectId, branchName } from "./paths.js";
import { ACTIVITY_STATES, AGENTS, KINDS, PR_STATUSES, STATUSES, type ActivityState, type Node } from "./tree.js";

export type Run = {
  id: string;
  project: string;
  repo: string;
  base: string;
  task: string;
  createdAt: string;
  nodes: Node[];
};

export type Store = {
  saveRun(run: Run): void;
  loadRun(runId: string): Run;
  listRuns(project?: string): string[];
  setActivity(runId: string, nodeId: string, state: ActivityState, agentSessionId?: string): boolean;
  createReport(runId: string, nodeId: string, kind: "done" | "stuck" | "needs-input", message?: string): number | null;
  queueMessage(runId: string, nodeId: string, message: string, from?: string): number | null;
  undeliveredMessages(runId: string, nodeId: string): { id: number; message: string }[];
  markDelivered(id: number): void;
  // After a daemon restart no agent is running; returns how many nodes were changed.
  exitStaleSessions(): number;
  close(): void;
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

type RunRow = { id: string; project: string; repo: string; base: string; task: string; created_at: string };
type NodeRow = {
  id: string; parent_id: string | null; depth: number; kind: string; title: string; prompt: string;
  files: string; agent: string; branch: string; worktree: string; status: string; attempts: number;
  summary: string | null; activity: string | null; agent_session_id: string | null; pr_status: string | null;
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
    INSERT INTO runs (id, project, repo, base, task, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET project = excluded.project, repo = excluded.repo,
      base = excluded.base, task = excluded.task, created_at = excluded.created_at`);
  const deleteNodes = db.prepare("DELETE FROM nodes WHERE run_id = ?");
  const insertNode = db.prepare(`
    INSERT INTO nodes (run_id, id, position, parent_id, depth, kind, title, prompt, files, agent,
      branch, worktree, status, attempts, summary, activity, pr_status, agent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const selectRun = db.prepare("SELECT * FROM runs WHERE id = ?");
  const selectNodes = db.prepare("SELECT * FROM nodes WHERE run_id = ? ORDER BY position");
  const updateActivity = db.prepare(`UPDATE nodes SET activity = ?, agent_session_id = COALESCE(?, agent_session_id)
    WHERE run_id = ? AND id = ?`);
  const sessionExists = db.prepare("SELECT 1 FROM nodes WHERE run_id = ? AND id = ?");
  const insertReport = db.prepare(`INSERT INTO reports (run_id, node_id, kind, message, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const insertMessage = db.prepare(`INSERT INTO outbox (run_id, node_id, from_session, message, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const selectUndelivered = db.prepare(`SELECT id, message FROM outbox
    WHERE run_id = ? AND node_id = ? AND delivered_at IS NULL ORDER BY id`);
  const updateDelivered = db.prepare("UPDATE outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
  const updateStale = db.prepare("UPDATE nodes SET activity = 'exited' WHERE activity IS NOT NULL AND activity <> 'exited'");

  function check(run: Run): void {
    assertId("run", run.id);
    assertProjectId(run.project);
    const ids = new Set<string>();
    for (const n of run.nodes) {
      assertId("node", n.id);
      ids.add(n.id);
    }
    for (const n of run.nodes) {
      // Later steps run git on this branch, so it must be the node's own.
      if (n.branch !== branchName(run.id, n.id)) {
        throw new RunStoreError(`run ${run.id} node ${n.id} has unexpected branch ${n.branch}`);
      }
      if (n.parentId !== null && !ids.has(n.parentId)) {
        throw new RunStoreError(`run ${run.id} node ${n.id} has unknown parent ${n.parentId}`);
      }
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
        upsertRun.run(run.id, run.project, run.repo, run.base, run.task, run.createdAt);
        deleteNodes.run(run.id);
        run.nodes.forEach((n, position) => {
          insertNode.run(
            run.id, n.id, position, n.parentId, n.depth, n.kind, n.title, n.prompt,
            JSON.stringify(n.files), n.agent, n.branch, n.worktree, n.status, n.attempts,
            n.summary ?? null, n.activity ?? null, n.prStatus ?? null, n.agentSessionId ?? null,
          );
        });
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw new RunStoreError(`could not save run ${run.id}: ${(e as Error).message}`);
      }
    },

    loadRun(runId) {
      const r = selectRun.get(runId) as RunRow | undefined;
      if (!r) throw new RunStoreError(`no run ${runId}`);
      const nodes = (selectNodes.all(runId) as NodeRow[]).map((n): Node => ({
        id: n.id,
        parentId: n.parent_id,
        depth: n.depth,
        kind: n.kind as Node["kind"],
        title: n.title,
        prompt: n.prompt,
        files: JSON.parse(n.files) as string[],
        agent: n.agent as Node["agent"],
        branch: n.branch,
        worktree: n.worktree,
        status: n.status as Node["status"],
        attempts: n.attempts,
        ...(n.summary !== null ? { summary: n.summary } : {}),
        ...(n.activity !== null ? { activity: n.activity as Node["activity"] } : {}),
        ...(n.agent_session_id !== null ? { agentSessionId: n.agent_session_id } : {}),
        ...(n.pr_status !== null ? { prStatus: n.pr_status as Node["prStatus"] } : {}),
      }));
      return {
        id: r.id, project: r.project, repo: r.repo, base: r.base, task: r.task,
        createdAt: r.created_at, nodes,
      };
    },

    listRuns(project) {
      const rows = (project === undefined
        ? db.prepare("SELECT id FROM runs ORDER BY id").all()
        : db.prepare("SELECT id FROM runs WHERE project = ? ORDER BY id").all(project)) as { id: string }[];
      return rows.map((r) => r.id);
    },

    setActivity(runId, nodeId, state, agentSessionId) {
      return updateActivity.run(state, agentSessionId ?? null, runId, nodeId).changes > 0;
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

    close() {
      db.close();
    },
  };
}
