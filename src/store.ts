import {journalStore,recoveryStatus,snapshotStore,verifyJournal} from "./recovery.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertId, assertProjectId, branchName } from "./paths.js";
import { ACTIVITY_STATES, AGENTS, NODE_ID, PR_STATUSES, ROLES, type ActivityState, type Node, type Role } from "./model.js";
import type { TaskSpec } from "./scheduler/tasks.js";
import { redact, TIMELINE_KINDS, type TimelineEntry, type TimelineKind } from "./timeline.js";
import type { ChatEvent } from "./chat/drivers.js";

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
  // The model asked for when it was started; otherwise the project's worker.viewl.
  model?: string;
  // The issue the task came from, in the run's own repository; its pull request closes it.
  issue?: number;
  // A task file's own definition of done, limits and guardrails for this run.
  spec?: TaskSpec;
  sharedWorkspace?: string;
  node: Node;
};

export type ConversationBranch = { id: string; parent: string | null; items: TimelineItem[]; snapshot: TimelineItem[]; provider: string; agent: string; active: boolean; strategy:string };
// How a thread is kept in the list. busy: a note while the agent says background work it
// started is still running; unread: something new since it was last opened.
export type Organization = { archivedAt: string | null; group: string; pinnedAt: string | null; snoozedUntil: string | null; unread: boolean; busy: string | null };
export type OrganizationPatch = { name?: string; archived?: boolean; group?: string; pinned?: boolean; snoozedUntil?: string | null; unread?: boolean; busy?: string | null };

export type LifecycleState = {
  state?: string; reactions?: Record<string,string>;
  attention?: string; approvedSha?: string; reviewAt?: number; reviewEscalated?: boolean;
  ciKey?: string; ciRetries?: number; ciEscalated?: boolean;
};

export type Store = {
  lifecycleState(runId: string, key: string): LifecycleState;
  saveLifecycleState(runId: string, key: string, value: LifecycleState): void;
  organizeRun(runId:string,patch:OrganizationPatch):void;
  organization(runId:string):Organization;
  journalEntries(after:number,limit:number):{sequence:number;schemaVersion:number;operation:string;recordedAt:string;hash:string;bytes:number}[];
  recoveryStatus(): ReturnType<typeof recoveryStatus>;
  verifyJournal(): ReturnType<typeof verifyJournal>;
  snapshot(path:string): ReturnType<typeof snapshotStore>;
  activeBranch(runId: string): ConversationBranch | undefined;
  branches(runId: string): ConversationBranch[];
  changeBranch(runId: string, prefix: TimelineItem[], history: TimelineItem[], restore?: string): string;
  saveRun(run: Run, fork?: ForkRecord): void;
  getFork(runId: string): ForkRecord | undefined;
  detachFork(runId: string): void;
  createThreads(sourceId: string, tasks: { task: string; name?: string }[]): string[];
  ownForkWorkspace(runId: string, path: string): void;
  workspaceForks(owner: string): string[];
  inherited(runId: string): TimelineItem[];
  contextTransfer(source: string, target: string, through: number): { id: string; delivered: boolean; attached: boolean } | undefined;
  pendingContextSize(target: string): number;
  listContextTransfers(runId: string): { id: string; sourceRun: string; targetRun: string; through: number; delivery: string }[];
  lastTransferPosition(source: string, target: string): number;
  transferContext(source: string, target: string, through: number, text: string): { id: string; duplicate: boolean };
  subscribeWait(target: string, caller: string, session: string, scope: string, turn: string): string;
  waitSubscriptions(): { id: string; target: string; caller: string; session: string; scope: string; turn: string }[];
  completeWait(id: string, message: string): void;
  loadRun(runId: string): Run;
  listRuns(project?: string): string[];
  // state null keeps the current activity (a hook that only reports the agent's own session id).
  setActivity(runId: string, nodeId: string, state: ActivityState | null, agentOwnId?: string): boolean;
  // A hook from the agent itself: activity, the first-signal time for this launch, and the
  // agent's conversation id (kept for every launch, so usage counts retries too).
  recordSignal(runId: string, nodeId: string, state: ActivityState | null, agentOwnId?: string): boolean;
  // A launch: idle until the agent's hooks say otherwise; it must prove its signal again.
  markLaunched(runId: string, nodeId: string, active?: boolean): void;
  // Every agent conversation a run's nodes have had.
  conversations(runId: string): { nodeId: string; agent: string; id: string }[];
  saveOutcome(runId: string, nodeId: string, kind: "done" | "blocked" | "question", message?: string): number | null;
  // mode: steer (typed in as soon as the agent can take it), queue (only once it is idle),
  // interrupt (its current turn is stopped first).
  queueMessage(runId: string, nodeId: string, message: string, from?: string, mode?: SendMode): number | null;
  undeliveredMessages(runId: string, nodeId: string): { id: number; message: string; mode: SendMode }[];
  // A message still waiting in Rivet can be changed or withdrawn; false once it has gone out.
  promoteQueued(runId: string, nodeId: string, id: number): boolean;
  editQueued(runId: string, nodeId: string, id: number, message: string): boolean;
  cancelQueued(runId: string, nodeId: string, id: number): boolean;
  markDelivered(id: number): void;
  // After a daemon restart no agent is running; returns how many nodes were changed.
  exitStaleSessions(): number;
  // Changes some fields of one node in place; null clears an optional field.
  updateNode(runId: string, nodeId: string, fields: NodeUpdate): void;
  // Per-project settings such as the check and test commands.
  getConfig(project: string): Record<string, string>;
  setConfig(project: string, key: string, value: string | null): void;
  // A run's pull request; "handled" remembers which feedback was already acted on.
  readReviewNotes(runId: string, number: number): string | null;
  writeReviewNotes(runId: string, guides: { number: number; text: string }[]): void;
  prLinks(runId: string): PrLink[];
  addPrLink(runId: string, pr: PrLink): void;
  updatePrLink(runId: string, number: number, status: string, handled?: string): void;
  removePrLink(runId: string, number: number): boolean;
  getPr(runId: string): PullRequest | null;
  setPr(runId: string, pr: PullRequest): void;
  clearPr(runId: string): void;
  // Review passes over a run's pull request, oldest first.
  startReview(runId: string, sha: string, trigger: Review["trigger"]): number;
  endReview(id: number, fields: { status: "complete" | "failed"; verdict?: Review["verdict"]; body?: string; postedReviewId?: number }): void;
  reviewsOf(runId: string): Review[];
  saveRoutine(a: Routine): void;
  listRoutines(project?: string): Routine[];
  deleteRoutine(id: string): boolean;
  recordRoutineRun(r: Omit<RoutineRun, "id">): void;
  routineRuns(routineId: string): RoutineRun[];
  // A project's snippets, by name.
  saveSnippet(snippet: Snippet): void;
  // A session's timeline (session: agent, review or partner). A prompt that repeats the
  // session's recent prompts or messages is the same one seen twice (Rivet and a hook) and is skipped.
  addTimeline(runId: string, session: string, entries: TimelineEntry[]): void;
  // Removes the timelines of a project's runs whose sessions all finished before a time;
  // returns how many entries went.
  pruneTimeline(project: string, before: string): number;
  // A project's runs whose sessions all finished before a time: those pruneTimeline empties.
  finishedBefore(project: string, before: string): string[];
  // Every project that has runs.
  listProjects(): string[];
  environmentInstructions(): string;
  setEnvironmentInstructions(text: string): void;
  projectMetadata(id: string): ProjectMetadata | null;
  saveProject(project: ProjectMetadata): void;
  deleteProject(id: string): void;
  projectDeleted(id: string): boolean;
  // A run's state changes after a position, oldest first.
  searchRuns(query: string, o: { project?: string; limit: number; offset?: number; pageSize?: number }): { runId: string; project: string; title: string; source: string; snippet: string; position?: number; history: string; branchId?: string }[];
  waitTurn(runId: string, turn?: string): { id: string; state: string } | undefined;
  readEvents(runId: string, o: { after?: number; limit: number }): RunEvent[];
  // Folds a chat session's events into its conversation; returns what they mean for the
  // session: its new activity, and the question it waits on (null once answered).
  recordChat(runId: string, session: string, events: ChatEvent[], receipt?: { id: string; accepted: number[] }): ChatOutcome;
  // A chat session's conversation as timeline entries, in the order they happened.
  readChat(runId: string, o: { after?: number; limit: number; kinds?: TimelineKind[]; session?: string }): { items: TimelineItem[]; total: number };
  chatUsage(runId: string, session?: string): ChatUsage | null;
  // Why a chat session's latest turn failed, as its agent said.
  lastTurnError(runId: string): string | null;
  // Keeps the agent's own lines as they came (a protocol message each).
  recordProviderLines(runId: string, session: string, lines: string[]): number;
  providerLines(runId: string, o: { after?: number; limit: number; session?: string }): { position: number; method: string; payload: string; at: string }[];
  // Entries after a position, oldest first; kinds narrows them (the messages view).
  readTimeline(runId: string, o: { after?: number; limit: number; kinds?: TimelineKind[]; session?: string }): { items: TimelineItem[]; total: number };
  listSnippets(project: string): Snippet[];
  deleteSnippet(project: string, name: string): boolean;
  // Whether the run ends (agents stopped, worktrees removed) once its pull request merges.
  getEndOnMerge(runId: string): boolean;
  setEndOnMerge(runId: string, terminate: boolean): void;
  // Rows this connection has changed since it opened; moves whenever stored state does.
  changeCount(): number;
  close(): void;
};

export type ProjectMetadata = {
  id: string;
  repo: string;
  title: string;
  instructions: string;
  scripts: { id: string; command: string }[];
};

export type PrLink = { number: number; url: string; status: string; handled?: string };
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
  postedReviewId?: number;
  createdAt: string;
};

// A saved prompt or command of a project, run by name.
export type Snippet = {
  project: string;
  name: string;
  // agent: a prompt for an agent; command: a shell command run in a terminal.
  type: "agent" | "command";
  text: string;
  updatedAt: string;
};

// A prompt run on a schedule: each time it comes round, a worker or orchestrator starts.
export type Routine = {
  id: string;
  project: string;
  repo: string;
  name: string;
  prompt: string;
  role: Role;
  agent?: string;
  cron: string;
  zone: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  createdAt: string;
};

// One time an routine came round: the run it started, or why it could not.
export type RoutineRun = { id: number; routineId: string; scheduledFor: string; runId?: string; error?: string; createdAt: string };

export const SEND_MODES = ["steer", "queue", "interrupt"] as const;
export type SendMode = (typeof SEND_MODES)[number];

export type ForkRecord = { sourceRun: string; rootRun: string; position: number; providerId: string; providerTurn?: string; agent: string; strategy: "pending" | "native" | "reconstructed"; detached?: boolean; ownsWorkspace?: boolean; independent?: boolean; items: TimelineItem[] };
export type TimelineItem = { position: number; session: string; kind: TimelineKind; tool?: string; text: string; at: string; streaming?: boolean; agent?: string; itemId?: string; turnId?: string; agentChatId?: string };
// A chat session's token use and context, as its agent last reported.
export type ChatUsage = { input: number; output: number; cached: number; total: number; contextUsed?: number; contextWindow?: number };
export type ChatOutcome = { activity?: ActivityState; question?: { tool: string; detail: string; requestId: string } | null; conversationId?: string };
export type RunEvent = { position: number; nodeId?: string; type: string; data: Record<string, unknown>; at: string };

export type NodeUpdate = {
  status?: Node["status"];
  attempts?: number;
  summary?: string | null;
  finishedAt?: string | null;
  // The task the session works on.
  prompt?: string;
  // Where the root's pull request stands.
  prStatus?: Node["prStatus"] | null;
  // The agent running the session (changed by a switch), and its own conversation id.
  agent?: Node["agent"];
  agentOwnId?: string | null;
  runMode?: Node["runMode"];
  agentChatId?: string | null;
};

const UPDATE_COLUMNS: Record<keyof NodeUpdate, string> = {
  status: "status", attempts: "attempts", summary: "summary", finishedAt: "finished_at", prompt: "prompt", prStatus: "pr_status",
  agent: "agent", agentOwnId: "agent_own_id", runMode: "run_mode", agentChatId: "agent_chat_id",
};

export class RunStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStoreError";
  }
}

export function forkedRunId(now: number = Date.now()): string {
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
const MIGRATIONS: { version: number; sql: string; run?(db: DatabaseSync): void }[] = [];

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
ALTER TABLE nodes ADD COLUMN agent_own_id TEXT;
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('done', 'blocked', 'question')),
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
  agent_own_id TEXT,
  activity_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, id)
);
INSERT INTO nodes_v3 (run_id, id, position, parent_id, depth, kind, title, prompt, files, agent, branch,
  worktree, status, attempts, summary, activity, pr_status, agent_own_id)
SELECT run_id, id, position, parent_id, depth, kind, title, prompt, files, agent, branch,
  worktree, status, attempts, summary, activity, pr_status, agent_own_id FROM nodes;
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
ALTER TABLE runs ADD COLUMN end_on_merge INTEGER NOT NULL DEFAULT 0 CHECK (end_on_merge IN (0, 1));
` });

// When a node first started, the first hook of its current launch, and every agent
// conversation a node has had (one per launch, plus conflict fixes on parents).
MIGRATIONS.push({ version: 6, sql: `
ALTER TABLE nodes ADD COLUMN started_at TEXT;
ALTER TABLE nodes ADD COLUMN first_heard_at TEXT;
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

// Chat sessions: how each session runs, and the conversation of a chat session (its
// turns, readable messages and activities), kept by Rivet.
// Adds the "delta" agent. The nodes table is copied with its current definition, only
// the agent list changed, since SQLite cannot change a CHECK constraint in place.
MIGRATIONS.push({ version: 29, sql: "", run: (db) => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get() as { sql: string };
  const sql = row.sql.replace(/agent IN \([^)]*\)/, `agent IN (${oneOf(AGENTS)})`).replace(/^CREATE TABLE "?nodes"?/, "CREATE TABLE nodes_v29");
  db.exec(`${sql}; INSERT INTO nodes_v29 SELECT * FROM nodes; DROP TABLE nodes; ALTER TABLE nodes_v29 RENAME TO nodes;`);
} });
MIGRATIONS.push({version:36,sql:`CREATE TABLE lifecycle_state (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id,key));`});
MIGRATIONS.push({ version: 35, sql: "ALTER TABLE pr_links ADD COLUMN handled TEXT NOT NULL DEFAULT '';" });
MIGRATIONS.push({ version: 34, sql: `
CREATE TABLE environment_preferences (id INTEGER PRIMARY KEY CHECK(id=1), instructions TEXT NOT NULL);
` });
MIGRATIONS.push({ version: 33, sql: `
CREATE TABLE pr_links (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (run_id, number)
);
` });
MIGRATIONS.push({ version: 32, sql: `
CREATE TABLE registered_projects (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  scripts TEXT NOT NULL,
  deleted_at TEXT
);
` });
MIGRATIONS.push({ version: 31, sql: `
CREATE TABLE review_notes (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number > 0),
  text TEXT NOT NULL,
  PRIMARY KEY (run_id, number)
);
` });
MIGRATIONS.push({version:30,sql:`ALTER TABLE run_organization ADD COLUMN pinned_at TEXT; ALTER TABLE run_organization ADD COLUMN snoozed_until TEXT; ALTER TABLE run_organization ADD COLUMN unread INTEGER NOT NULL DEFAULT 0; ALTER TABLE run_organization ADD COLUMN busy TEXT;`});
MIGRATIONS.push({version:28,sql:`ALTER TABLE conversation_branches ADD COLUMN strategy TEXT NOT NULL DEFAULT 'original';`});
MIGRATIONS.push({version:27,sql:`CREATE TABLE run_organization(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, archived_at TEXT, group_name TEXT NOT NULL DEFAULT '');`});
MIGRATIONS.push({version:26,sql:`CREATE TABLE recovery_journal(sequence INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, operation TEXT NOT NULL, recorded_at TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL, changes BLOB NOT NULL);`});

MIGRATIONS.push({ version: 25, sql: `
CREATE TABLE conversation_branches (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, parent TEXT, items TEXT NOT NULL, snapshot TEXT NOT NULL, provider TEXT NOT NULL, agent TEXT NOT NULL, active INTEGER NOT NULL);
CREATE UNIQUE INDEX conversation_branch_active ON conversation_branches(run_id) WHERE active = 1;
` });

MIGRATIONS.push({ version: 24, sql: `
CREATE TABLE wait_subscriptions (id TEXT PRIMARY KEY, target TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, caller TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, session TEXT NOT NULL, scope TEXT NOT NULL, turn TEXT NOT NULL, UNIQUE(target,caller,session,scope,turn));
` });

MIGRATIONS.push({ version: 23, sql: `
CREATE TABLE chat_receipts (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, session TEXT NOT NULL, id TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(run_id, session, id));
` });

MIGRATIONS.push({ version: 22, sql: `
SELECT 1;
` });

MIGRATIONS.push({ version: 21, sql: `
ALTER TABLE context_transfers ADD COLUMN attached INTEGER NOT NULL DEFAULT 0 CHECK (attached IN (0,1));
` });

MIGRATIONS.push({ version: 20, sql: `
CREATE VIRTUAL TABLE chat_search USING fts5(body, content='chat_log', content_rowid='rowid', tokenize='trigram');
INSERT INTO chat_search(rowid, body) SELECT rowid, body FROM chat_log WHERE step IS NULL AND progress = 'final';
CREATE TRIGGER chat_search_insert AFTER INSERT ON chat_log WHEN new.step IS NULL AND new.progress = 'final' BEGIN
  INSERT INTO chat_search(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER chat_search_update AFTER UPDATE OF body, progress ON chat_log WHEN new.step IS NULL BEGIN
  INSERT INTO chat_search(chat_search, rowid, body) SELECT 'delete', old.rowid, old.body WHERE old.progress = 'final';
  INSERT INTO chat_search(rowid, body) SELECT new.rowid, new.body WHERE new.progress = 'final';
END;
CREATE TRIGGER chat_search_delete AFTER DELETE ON chat_log WHEN old.step IS NULL AND old.progress = 'final' BEGIN
  INSERT INTO chat_search(chat_search, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE VIRTUAL TABLE timeline_search USING fts5(text, content='timeline', content_rowid='id', tokenize='trigram');
INSERT INTO timeline_search(rowid, text) SELECT id, text FROM timeline WHERE session = 'agent' AND kind IN ('prompt', 'message', 'assistant');
CREATE TRIGGER timeline_search_insert AFTER INSERT ON timeline WHEN new.session = 'agent' AND new.kind IN ('prompt','message','assistant') BEGIN
  INSERT INTO timeline_search(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER timeline_search_delete AFTER DELETE ON timeline WHEN old.session = 'agent' AND old.kind IN ('prompt','message','assistant') BEGIN
  INSERT INTO timeline_search(timeline_search, rowid, text) VALUES ('delete', old.id, old.text);
END;
` });

MIGRATIONS.push({ version: 19, sql: `
CREATE TABLE thread_forks (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  source_run TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  root_run TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  data_json TEXT NOT NULL
);
CREATE TABLE context_transfers (
  id TEXT PRIMARY KEY,
  source_run TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  target_run TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  through_position INTEGER NOT NULL,
  message_id INTEGER NOT NULL REFERENCES outbox(id),
  created_at TEXT NOT NULL,
  UNIQUE(source_run, target_run, through_position)
);
` });
// Which agent ran each chat turn, so a handoff credits every answer to the agent that gave it.
MIGRATIONS.push({ version: 18, sql: `
SELECT 1;
` });

MIGRATIONS.push({ version: 17, sql: `
ALTER TABLE nodes ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'terminal' CHECK (run_mode IN ('terminal', 'chat'));
ALTER TABLE nodes ADD COLUMN agent_chat_id TEXT NOT NULL DEFAULT '';
-- One agent conversation of a run's session, with Rivet's counters for it.
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session TEXT NOT NULL,
  -- Where the next entry of its log goes.
  next_position INTEGER NOT NULL DEFAULT 1,
  -- Tokens and context, as the agent last reported them.
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cached INTEGER,
  tokens_total INTEGER,
  context_filled INTEGER,
  context_size INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, session)
);
-- One prompt and the work it led to. ended_as stays empty while the agent works on it.
CREATE TABLE chat_turns (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  agent TEXT NOT NULL DEFAULT '',
  agent_turn TEXT NOT NULL DEFAULT '',
  agent_chat_id TEXT NOT NULL DEFAULT '',
  began_at TEXT NOT NULL,
  ended_at TEXT,
  ended_as TEXT CHECK (ended_as IN ('done', 'stopped', 'failed')),
  problem TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX chat_turns_by_agent ON chat_turns (chat_id, agent_turn) WHERE agent_turn <> '';
-- A conversation's log, in the order things happened. A row is either something said
-- (said_by set) or something done: a command, an edit, a question (step set).
CREATE TABLE chat_log (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  turn_id TEXT REFERENCES chat_turns(id) ON DELETE SET NULL,
  said_by TEXT CHECK (said_by IN ('user', 'assistant')),
  step TEXT,
  -- Something said is 'writing' until its last words arrive, then 'final'; a step keeps
  -- its own state (running, completed, failed, pending, resolved).
  progress TEXT NOT NULL DEFAULT 'final',
  body TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  -- The agent's own id for the item, and for a question it asked.
  item_key TEXT NOT NULL DEFAULT '',
  question_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chat_id, position),
  CHECK ((said_by IS NULL) <> (step IS NULL))
);
CREATE UNIQUE INDEX chat_log_said ON chat_log (chat_id, item_key) WHERE step IS NULL AND item_key <> '';
CREATE UNIQUE INDEX chat_log_done ON chat_log (chat_id, item_key) WHERE step IS NOT NULL AND item_key <> '';
CREATE UNIQUE INDEX chat_log_question ON chat_log (chat_id, question_key) WHERE question_key <> '';
-- Every line the agent wrote, as it came: the evidence when Rivet's reading of it is wrong.
-- Never shown as the conversation and never given back to an agent.
CREATE TABLE chat_raw (
  position INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  line TEXT NOT NULL,
  seen_at TEXT NOT NULL
);
CREATE INDEX chat_raw_by_chat ON chat_raw (chat_id, position);
` });

// Every change to a run's state, in order, kept beside the tables that hold its current state.
MIGRATIONS.push({ version: 16, sql: `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX events_run ON events (run_id, id);
` });

// Each session's timeline: what it was told, did and said.
MIGRATIONS.push({ version: 15, sql: `
CREATE TABLE timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('prompt', 'message', 'assistant', 'tool', 'result', 'event')),
  tool TEXT,
  text TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX timeline_run ON timeline (run_id, id);
` });

// How a sent message is to be delivered.
MIGRATIONS.push({ version: 14, sql: `
ALTER TABLE outbox ADD COLUMN mode TEXT NOT NULL DEFAULT 'steer' CHECK (mode IN ('steer', 'queue', 'interrupt'));
` });

// A task file's definition of done, limits and guardrails, as JSON.
MIGRATIONS.push({ version: 13, sql: `
ALTER TABLE runs ADD COLUMN spec TEXT;
` });

// Prompts run on a schedule, and each time they ran.
MIGRATIONS.push({ version: 12, sql: `
CREATE TABLE routines (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (${oneOf(ROLES)})),
  agent TEXT,
  cron TEXT NOT NULL,
  zone TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project, name)
);
CREATE TABLE routine_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  run_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
` });

// Saved prompts and commands per project.
MIGRATIONS.push({ version: 11, sql: `
CREATE TABLE snippets (
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
  posted_review_id INTEGER,
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
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      m.run?.(db);
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
  role: string; name: string; orchestrator: string | null; model: string | null; issue: number | null; spec: string | null;
};
type NodeRow = {
  id: string; parent_id: string | null; depth: number; kind: string; title: string; prompt: string;
  files: string; agent: string; branch: string; worktree: string; status: string; attempts: number;
  summary: string | null; activity: string | null; agent_own_id: string | null; pr_status: string | null;
  activity_at: string | null; finished_at: string | null; started_at: string | null; first_heard_at: string | null;
  shared: string; run_mode: string; agent_chat_id: string;
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
    INSERT INTO runs (id, project, repo, base, task, created_at, role, name, orchestrator, model, issue, spec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET project = excluded.project, repo = excluded.repo,
      base = excluded.base, task = excluded.task, created_at = excluded.created_at,
      role = excluded.role, name = excluded.name, orchestrator = excluded.orchestrator, model = excluded.model, issue = excluded.issue, spec = excluded.spec`);
  const deleteNodes = db.prepare("DELETE FROM nodes WHERE run_id = ?");
  const insertNode = db.prepare(`
    INSERT INTO nodes (run_id, id, position, parent_id, depth, kind, title, prompt, files, agent,
      branch, worktree, status, attempts, summary, activity, pr_status, agent_own_id, activity_at, finished_at,
      started_at, first_heard_at, shared, run_mode, agent_chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const selectRun = db.prepare("SELECT * FROM runs WHERE id = ?");
  const selectNodes = db.prepare("SELECT * FROM nodes WHERE run_id = ? ORDER BY position");
  const updateActivity = db.prepare(`UPDATE nodes SET activity = COALESCE(?, activity),
    activity_at = CASE WHEN ? IS NULL THEN activity_at ELSE ? END,
    agent_own_id = COALESCE(?, agent_own_id)
    WHERE run_id = ? AND id = ?`);
  const selectConfig = db.prepare("SELECT key, value FROM project_config WHERE project = ? ORDER BY key");
  const upsertConfig = db.prepare(`INSERT INTO project_config (project, key, value) VALUES (?, ?, ?)
    ON CONFLICT (project, key) DO UPDATE SET value = excluded.value`);
  const deleteConfig = db.prepare("DELETE FROM project_config WHERE project = ? AND key = ?");
  const sessionExists = db.prepare("SELECT 1 FROM nodes WHERE run_id = ? AND id = ?");
  const insertReport = db.prepare(`INSERT INTO reports (run_id, node_id, kind, message, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const insertMessage = db.prepare(`INSERT INTO outbox (run_id, node_id, from_session, message, created_at, mode)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const selectUndelivered = db.prepare(`SELECT id, message, mode FROM outbox
    WHERE run_id = ? AND node_id = ? AND delivered_at IS NULL
      AND id NOT IN (SELECT message_id FROM context_transfers WHERE attached = 0) ORDER BY id`);
  const updateDelivered = db.prepare("UPDATE outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
  const updateSignal = db.prepare(`UPDATE nodes SET activity = COALESCE(?, activity),
    activity_at = CASE WHEN ? IS NULL THEN activity_at ELSE ? END,
    agent_own_id = COALESCE(?, agent_own_id),
    first_heard_at = COALESCE(first_heard_at, ?)
    WHERE run_id = ? AND id = ?`);
  const insertConversation = db.prepare(`INSERT INTO conversations (run_id, node_id, agent, conversation_id, seen_at)
    SELECT run_id, id, agent, ?, ? FROM nodes WHERE run_id = ? AND id = ?
    ON CONFLICT DO NOTHING`);
  const updateLaunched = db.prepare(`UPDATE nodes SET activity = ?, activity_at = ?, first_heard_at = NULL,
    started_at = COALESCE(started_at, ?) WHERE run_id = ? AND id = ?`);
  const selectConversations = db.prepare(`SELECT node_id, agent, conversation_id FROM conversations
    WHERE run_id = ? ORDER BY seen_at, node_id`);
  const updateStale = db.prepare("UPDATE nodes SET activity = 'ended' WHERE activity IS NOT NULL AND activity <> 'ended'");

  function forkRecord(runId: string): ForkRecord | undefined {
    const row = db.prepare("SELECT data_json FROM thread_forks WHERE run_id = ?").get(runId) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as ForkRecord : undefined;
  }
  function check(run: Run, fork?: ForkRecord): void {
    assertId("run", run.id);
    assertProjectId(run.project);
    assertId("node", run.node.id);
    // Later steps run git on this branch, so it must be the node's own.
    const lineage = fork ?? forkRecord(run.id);
    const owner = lineage?.ownsWorkspace ? undefined : lineage?.rootRun;
    if (owner) {
      const original = (selectNodes.all(owner) as NodeRow[])[0];
      const originalRun = selectRun.get(owner) as RunRow | undefined;
      if (!original || original.worktree !== run.node.worktree || !originalRun || originalRun.repo !== run.repo || originalRun.project !== run.project) throw new RunStoreError("fork checkout must match its owner");
    }
    if (run.node.branch !== branchName(owner ?? run.id, run.node.id)) {
      throw new RunStoreError(`run ${run.id} has unexpected branch ${run.node.branch}`);
    }
  }

  function branches(runId: string): ConversationBranch[] {
    return (db.prepare("SELECT * FROM conversation_branches WHERE run_id=? ORDER BY rowid").all(runId) as {id:string;parent:string|null;items:string;snapshot:string;provider:string;agent:string;active:number;strategy:string}[]).map(r=>({...r,items:JSON.parse(r.items) as TimelineItem[],snapshot:JSON.parse(r.snapshot) as TimelineItem[],active:!!r.active}));
  }
  const prefixFor = (runId: string) => branches(runId).find(b=>b.active)?.items ?? forkRecord(runId)?.items ?? [];
  const insertEvent = db.prepare("INSERT INTO events (run_id, node_id, type, data, at) VALUES (?, ?, ?, ?, ?)");
  const selectActivity = db.prepare("SELECT activity FROM nodes WHERE run_id = ? AND id = ?");
  const selectStatus = db.prepare("SELECT status FROM nodes WHERE run_id = ? AND id = ?");
  const selectStale = db.prepare("SELECT run_id, id, activity FROM nodes WHERE activity IS NOT NULL AND activity <> 'ended'");
  // Written in the same call as the change it records; a failure to log never fails the change.
  function logEvent(runId: string, nodeId: string | null, type: string, data: Record<string, unknown> = {}): void {
    try { insertEvent.run(runId, nodeId, type, JSON.stringify(data), new Date().toISOString()); } catch { /* run gone */ }
  }
  // Hooks report activity on every tool call; only a change is an event.
  function activityBefore(runId: string, nodeId: string): string | null | undefined {
    return (selectActivity.get(runId, nodeId) as { activity: string | null } | undefined)?.activity;
  }

  const store: Store = {
    journalEntries:(after,limit)=>db.prepare("SELECT sequence,schema_version AS schemaVersion,operation,recorded_at AS recordedAt,hash,length(changes) AS bytes FROM recovery_journal WHERE sequence>? ORDER BY sequence LIMIT ?").all(after,limit) as {sequence:number;schemaVersion:number;operation:string;recordedAt:string;hash:string;bytes:number}[],
    recoveryStatus:()=>recoveryStatus(db,data),
    verifyJournal:()=>verifyJournal(db),
    snapshot:path=>snapshotStore(db,path),
    organization(runId) {
      const row=db.prepare("SELECT archived_at AS archivedAt,group_name AS 'group',pinned_at AS pinnedAt,snoozed_until AS snoozedUntil,unread,busy FROM run_organization WHERE run_id=?").get(runId) as (Omit<Organization,"unread">&{unread:number})|undefined;
      return row?{...row,unread:!!row.unread}:{archivedAt:null,group:"",pinnedAt:null,snoozedUntil:null,unread:false,busy:null};
    },
    organizeRun(runId,patch) {
      if(!selectRun.get(runId))throw new RunStoreError("unknown run");
      if(patch.name!==undefined){db.prepare("UPDATE runs SET name=? WHERE id=?").run(patch.name,runId);db.prepare("UPDATE nodes SET title=? WHERE run_id=? AND id='agent'").run(patch.name,runId);}
      db.prepare("INSERT OR IGNORE INTO run_organization(run_id) VALUES (?)").run(runId);
      if(patch.archived!==undefined)db.prepare("UPDATE run_organization SET archived_at=? WHERE run_id=?").run(patch.archived?new Date().toISOString():null,runId);
      if(patch.group!==undefined)db.prepare("UPDATE run_organization SET group_name=? WHERE run_id=?").run(patch.group,runId);
      if(patch.pinned!==undefined)db.prepare("UPDATE run_organization SET pinned_at=? WHERE run_id=?").run(patch.pinned?new Date().toISOString():null,runId);
      if(patch.snoozedUntil!==undefined)db.prepare("UPDATE run_organization SET snoozed_until=? WHERE run_id=?").run(patch.snoozedUntil,runId);
      if(patch.unread!==undefined)db.prepare("UPDATE run_organization SET unread=? WHERE run_id=?").run(patch.unread?1:0,runId);
      if(patch.busy!==undefined)db.prepare("UPDATE run_organization SET busy=? WHERE run_id=?").run(patch.busy,runId);
      // Read marks and busy notes change often and say nothing about the thread itself.
      if(Object.keys(patch).some(k=>k!=="unread"&&k!=="busy"))logEvent(runId,NODE_ID,"thread.organized",patch);
    },
    saveRun(run, fork) {
      if (db.prepare("SELECT 1 FROM registered_projects WHERE id=? AND deleted_at IS NOT NULL").get(run.project)) throw new RunStoreError("project has been deleted");
      try {
        check(run, fork);
      } catch (e) {
        throw e instanceof RunStoreError ? e : new RunStoreError((e as Error).message);
      }
      db.exec("SAVEPOINT store_write");
      try {
        const before = selectRun.get(run.id) ? (selectStatus.get(run.id, run.node.id) as { status: string } | undefined)?.status ?? null : undefined;
        upsertRun.run(run.id, run.project, run.repo, run.base, run.task, run.createdAt, run.role, run.name, run.orchestrator ?? null, run.model ?? null, run.issue ?? null, run.spec ? JSON.stringify(run.spec) : null);
        deleteNodes.run(run.id);
        const n = run.node;
        // The position, parent, depth, kind, files and shared columns are left from runs that
        // had several nodes; a one-node run fills them with their neutral values.
        insertNode.run(
          run.id, n.id, 0, null, 0, "leaf", n.title, n.prompt,
          "[]", n.agent, n.branch, n.worktree, n.status, n.attempts,
          n.summary ?? null, n.activity ?? null, n.prStatus ?? null, n.agentOwnId ?? null,
          n.activityAt ?? null, n.finishedAt ?? null, n.startedAt ?? null, n.firstHeardAt ?? null,
          "[]", n.runMode ?? "terminal", n.agentChatId ?? "",
        );
        if (fork) {
          db.prepare("INSERT INTO thread_forks (run_id, source_run, root_run, data_json) VALUES (?, ?, ?, ?)").run(run.id, fork.sourceRun, fork.rootRun, JSON.stringify(fork));
          logEvent(run.id, n.id, "conversation.forked", { source: fork.sourceRun, position: fork.position });
        }
        // Creation is recorded once, followed only by real state changes.
        if (before === undefined) logEvent(run.id, n.id, "run.added", { status: n.status, agent: n.agent });
        else if (before !== n.status) logEvent(run.id, n.id, "run.changed", { status: n.status });
        db.exec("RELEASE store_write");
      } catch (e) {
        db.exec("ROLLBACK TO store_write; RELEASE store_write");
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
        ...(n.agent_own_id !== null ? { agentOwnId: n.agent_own_id } : {}),
        ...(n.pr_status !== null ? { prStatus: n.pr_status as Node["prStatus"] } : {}),
        ...(n.activity_at !== null ? { activityAt: n.activity_at } : {}),
        ...(n.finished_at !== null ? { finishedAt: n.finished_at } : {}),
        ...(n.started_at !== null ? { startedAt: n.started_at } : {}),
        ...(n.first_heard_at !== null ? { firstHeardAt: n.first_heard_at } : {}),
        ...(n.run_mode === "chat" ? { runMode: "chat" as const } : {}),
        ...(n.agent_chat_id ? { agentChatId: n.agent_chat_id } : {}),
      }));
      if (!nodes[0]) throw new RunStoreError(`run ${runId} has no session`);
      return {
        id: r.id, project: r.project, repo: r.repo, base: r.base, task: r.task,
        createdAt: r.created_at, role: r.role as Role, name: r.name,
        ...(r.orchestrator !== null ? { orchestrator: r.orchestrator } : {}),
        ...(r.model !== null ? { model: r.model } : {}),
        ...(r.issue !== null ? { issue: Number(r.issue) } : {}),
        ...(r.spec !== null ? { spec: JSON.parse(r.spec) as TaskSpec } : {}),
        ...(forkRecord(runId) && !forkRecord(runId)!.ownsWorkspace ? { sharedWorkspace: forkRecord(runId)!.rootRun } : {}),
        node: nodes[0],
      };
    },

    listRuns(project) {
      const rows = (project === undefined
        ? db.prepare("SELECT id FROM runs ORDER BY id").all()
        : db.prepare("SELECT id FROM runs WHERE project = ? ORDER BY id").all(project)) as { id: string }[];
      return rows.map((r) => r.id);
    },

    setActivity(runId, nodeId, state, agentOwnId) {
      const before = activityBefore(runId, nodeId);
      const now = state === null ? null : new Date().toISOString();
      const found = updateActivity.run(state, now, now, agentOwnId ?? null, runId, nodeId).changes > 0;
      if (found && state !== null && state !== before) logEvent(runId, nodeId, "activity", { from: before ?? null, to: state });
      return found;
    },

    recordSignal(runId, nodeId, state, agentOwnId) {
      const before = activityBefore(runId, nodeId);
      const now = new Date().toISOString();
      const at = state === null ? null : now;
      const found = updateSignal.run(state, at, at, agentOwnId ?? null, now, runId, nodeId).changes > 0;
      if (found && agentOwnId) insertConversation.run(agentOwnId, now, runId, nodeId);
      if (found && state !== null && state !== before) logEvent(runId, nodeId, "activity", { from: before ?? null, to: state });
      return found;
    },

    markLaunched(runId, nodeId, active = false) {
      const now = new Date().toISOString();
      updateLaunched.run(active ? "busy" : "idle", now, now, runId, nodeId);
      logEvent(runId, nodeId, "launched");
    },

    conversations(runId) {
      return (selectConversations.all(runId) as { node_id: string; agent: string; conversation_id: string }[])
        .map((r) => ({ nodeId: r.node_id, agent: r.agent, id: r.conversation_id }));
    },

    saveOutcome(runId, nodeId, kind, message) {
      if (!sessionExists.get(runId, nodeId)) return null;
      const id = Number(insertReport.run(runId, nodeId, kind, message ?? null, new Date().toISOString()).lastInsertRowid);
      logEvent(runId, nodeId, "report", { kind });
      return id;
    },

    queueMessage(runId, nodeId, message, from, mode = "steer") {
      if (!sessionExists.get(runId, nodeId)) return null;
      db.exec("SAVEPOINT store_write");
      try {
        const pending = nodeId === NODE_ID ? db.prepare("SELECT t.id, t.message_id, o.message FROM context_transfers t JOIN outbox o ON o.id = t.message_id WHERE t.target_run = ? AND t.attached = 0 ORDER BY t.created_at, t.id").all(runId) as { id: string; message_id: number; message: string }[] : [];
        const text = pending.length ? pending.map((p) => p.message).join("\n\n") + "\n\nNew user message:\n" + message : message;
        if (pending.length && text.length > 100000) throw new RunStoreError("message plus pending context exceeds 100000 characters; use a shorter message");
        const now = new Date().toISOString();
        const id = Number(insertMessage.run(runId, nodeId, from ?? null, text, now, mode).lastInsertRowid);
        for (const p of pending) {
          db.prepare("UPDATE context_transfers SET message_id = ?, attached = 1 WHERE id = ?").run(id, p.id);
          db.prepare("UPDATE outbox SET delivered_at = ? WHERE id = ?").run(now, p.message_id);
        }
        logEvent(runId, nodeId, "message.queued", { id, mode, from: from ?? null, ...(pending.length ? { transfers: pending.map((p) => p.id) } : {}) });
        db.exec("RELEASE store_write");
        return id;
      } catch (e) { db.exec("ROLLBACK TO store_write; RELEASE store_write"); throw e; }
    },

    undeliveredMessages(runId, nodeId) {
      return (selectUndelivered.all(runId, nodeId) as { id: number; message: string; mode: SendMode }[])
        .map((r) => ({ id: Number(r.id), message: r.message, mode: r.mode }));
    },

    promoteQueued(runId, nodeId, id) {
      const result = db.prepare("UPDATE outbox SET mode='steer' WHERE id=? AND run_id=? AND node_id=? AND delivered_at IS NULL AND mode='queue'").run(id, runId, nodeId);
      if (result.changes) logEvent(runId, nodeId, "message.promoted", { id });
      return result.changes > 0;
    },

    editQueued(runId, nodeId, id, message) {
      const changed = db.prepare("UPDATE outbox SET message = ? WHERE id = ? AND run_id = ? AND node_id = ? AND delivered_at IS NULL").run(message, id, runId, nodeId).changes > 0;
      if (changed) logEvent(runId, nodeId, "message.edited", { id });
      return changed;
    },

    cancelQueued(runId, nodeId, id) {
      // A message that carries transferred context keeps it; withdrawing it would drop that context.
      if (db.prepare("SELECT 1 FROM context_transfers WHERE message_id = ?").get(id)) throw new RunStoreError("this message carries transferred context; edit it instead");
      const removed = db.prepare("DELETE FROM outbox WHERE id = ? AND run_id = ? AND node_id = ? AND delivered_at IS NULL").run(id, runId, nodeId).changes > 0;
      if (removed) logEvent(runId, nodeId, "message.cancelled", { id });
      return removed;
    },

    markDelivered(id) {
      if (updateDelivered.run(new Date().toISOString(), id).changes === 0) return;
      const row = db.prepare("SELECT run_id, node_id FROM outbox WHERE id = ?").get(id) as { run_id: string; node_id: string } | undefined;
      if (row) logEvent(row.run_id, row.node_id, "message.delivered", { id });
    },

    exitStaleSessions() {
      // Record each session left behind by a stopped daemon as exited.
      const stale = selectStale.all() as { run_id: string; id: string; activity: string }[];
      for (const s of stale) logEvent(s.run_id, s.id, "session.closed", { from: s.activity, reason: "daemon restarted" });
      return Number(updateStale.run().changes);
    },

    updateNode(runId, nodeId, fields) {
      const keys = (Object.keys(fields) as (keyof NodeUpdate)[]).filter((k) => fields[k] !== undefined);
      if (keys.length === 0) return;
      const old = db.prepare(`SELECT ${keys.map((k) => UPDATE_COLUMNS[k]).join(", ")} FROM nodes WHERE run_id = ? AND id = ?`)
        .get(runId, nodeId) as Record<string, unknown> | undefined;
      const sql = `UPDATE nodes SET ${keys.map((k) => `${UPDATE_COLUMNS[k]} = ?`).join(", ")} WHERE run_id = ? AND id = ?`;
      const changed = db.prepare(sql).run(...keys.map((k) => fields[k] as string | number | null), runId, nodeId).changes;
      if (changed === 0) throw new RunStoreError(`no node ${nodeId} in run ${runId}`);
      // Only what actually changed, as with a re-saved run.
      const diff = keys.filter((k) => old?.[UPDATE_COLUMNS[k]] !== fields[k]);
      if (diff.length) logEvent(runId, nodeId, "run.changed", Object.fromEntries(diff.map((k) => [k, fields[k]])));
    },

    saveRoutine(a) {
      db.prepare(`INSERT INTO routines (id, project, repo, name, prompt, role, agent, cron, zone, enabled, next_run_at, last_run_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET prompt = excluded.prompt, role = excluded.role, agent = excluded.agent, cron = excluded.cron,
          zone = excluded.zone, enabled = excluded.enabled, next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at`)
        .run(a.id, a.project, a.repo, a.name, a.prompt, a.role, a.agent ?? null, a.cron, a.zone, a.enabled ? 1 : 0, a.nextRunAt, a.lastRunAt ?? null, a.createdAt);
    },

    listRoutines(project) {
      type Row = { id: string; project: string; repo: string; name: string; prompt: string; role: Role; agent: string | null; cron: string;
        zone: string; enabled: number; next_run_at: string; last_run_at: string | null; created_at: string };
      const rows = (project === undefined
        ? db.prepare("SELECT * FROM routines ORDER BY project, name").all()
        : db.prepare("SELECT * FROM routines WHERE project = ? ORDER BY name").all(project)) as Row[];
      return rows.map((r) => ({
        id: r.id, project: r.project, repo: r.repo, name: r.name, prompt: r.prompt, role: r.role, cron: r.cron, zone: r.zone,
        enabled: r.enabled === 1, nextRunAt: r.next_run_at, createdAt: r.created_at,
        ...(r.agent !== null ? { agent: r.agent } : {}), ...(r.last_run_at !== null ? { lastRunAt: r.last_run_at } : {}),
      }));
    },

    deleteRoutine(id) {
      return db.prepare("DELETE FROM routines WHERE id = ?").run(id).changes > 0;
    },

    recordRoutineRun(r) {
      db.prepare("INSERT INTO routine_runs (routine_id, scheduled_for, run_id, error, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(r.routineId, r.scheduledFor, r.runId ?? null, r.error ?? null, r.createdAt);
    },

    routineRuns(routineId) {
      type Row = { id: number; routine_id: string; scheduled_for: string; run_id: string | null; error: string | null; created_at: string };
      return (db.prepare("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id").all(routineId) as Row[]).map((r) => ({
        id: Number(r.id), routineId: r.routine_id, scheduledFor: r.scheduled_for, createdAt: r.created_at,
        ...(r.run_id !== null ? { runId: r.run_id } : {}), ...(r.error !== null ? { error: r.error } : {}),
      }));
    },

    addTimeline(runId, session, entries) {
      const lastSaid = db.prepare("SELECT text FROM timeline WHERE run_id = ? AND session = ? AND kind IN ('prompt', 'message') ORDER BY id DESC LIMIT 5");
      const insert = db.prepare("INSERT INTO timeline (run_id, session, kind, tool, text, at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const e of entries) {
        const text = redact(e.text);
        if (e.kind === "prompt") {
          const recent = lastSaid.all(runId, session) as { text: string }[];
          if (recent.some((r) => r.text.trim() === text.trim())) continue;
        }
        insert.run(runId, session, e.kind, e.tool ?? null, text, new Date().toISOString());
      }
    },

    pruneTimeline(project, before) {
      // Copies of inherited history follow the finished fork's own retention window.
      // Keep lineage/provider anchors so pruning never changes checkout ownership.
      db.prepare(`UPDATE thread_forks SET data_json = json_set(data_json, '$.items', json('[]'))
        WHERE json_array_length(data_json, '$.items') > 0 AND run_id IN (
          SELECT r.id FROM runs r WHERE r.project = ?
            AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id)
            AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id
              AND (n.finished_at IS NULL OR n.finished_at >= ? OR n.status IN ('pending', 'running'))))`)
        .run(project, before);
      db.prepare(`DELETE FROM chat_sessions WHERE run_id IN (
        SELECT r.id FROM runs r WHERE r.project = ?
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id AND (n.finished_at IS NULL OR n.finished_at >= ?)))`).run(project, before);
      db.prepare(`DELETE FROM events WHERE run_id IN (
        SELECT r.id FROM runs r WHERE r.project = ?
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id AND (n.finished_at IS NULL OR n.finished_at >= ?)))`).run(project, before);
      // Old conversation branches and delivered messages hold the same history in other places.
      db.prepare(`UPDATE conversation_branches SET items = '[]', snapshot = '[]' WHERE active = 0 AND (items <> '[]' OR snapshot <> '[]') AND run_id IN (
        SELECT r.id FROM runs r WHERE r.project = ?
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id AND (n.finished_at IS NULL OR n.finished_at >= ?)))`).run(project, before);
      db.prepare(`UPDATE outbox SET message = '' WHERE delivered_at IS NOT NULL AND message <> '' AND run_id IN (
        SELECT r.id FROM runs r WHERE r.project = ?
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id AND (n.finished_at IS NULL OR n.finished_at >= ?)))`).run(project, before);
      return Number(db.prepare(`DELETE FROM timeline WHERE run_id IN (
        SELECT r.id FROM runs r WHERE r.project = ?
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id AND (n.finished_at IS NULL OR n.finished_at >= ?)))`)
        .run(project, before).changes);
    },

    finishedBefore(project, before) {
      return (db.prepare(`SELECT r.id FROM runs r WHERE r.project = ?
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id AND (n.finished_at IS NULL OR n.finished_at >= ?))`).all(project, before) as { id: string }[]).map((r) => r.id);
    },

    activeBranch(runId) {return branches(runId).find(b=>b.active);},
    branches,
    changeBranch(runId, prefix, history, restore) {
      const node = db.prepare("SELECT agent_chat_id AS provider, agent FROM nodes WHERE run_id=? AND id='agent'").get(runId) as {provider:string;agent:string};
      const target = restore ? branches(runId).find(b=>b.id===restore) : undefined;
      if (restore && !target) throw new RunStoreError("unknown conversation branch");
      if (target?.active) return target.id;
      db.exec("SAVEPOINT store_write");
      try {
        let current = branches(runId).find(b=>b.active);
        if (!current) {
          const id = randomBytes(8).toString("hex");
          db.prepare("INSERT INTO conversation_branches(id,run_id,parent,items,snapshot,provider,agent,active) VALUES (?,?,NULL,?,?,?,?,1)").run(id,runId,JSON.stringify(forkRecord(runId)?.items ?? []),JSON.stringify(history),node.provider,node.agent);
          current = branches(runId).find(b=>b.active)!;
        }
        db.prepare("UPDATE conversation_branches SET snapshot=?,provider=?,agent=?,active=0 WHERE id=?").run(JSON.stringify(history),node.provider,node.agent,current.id);
        db.prepare("UPDATE chat_sessions SET session=? WHERE run_id=? AND session='agent'").run('branch-'+current.id,runId);
        const id = target?.id ?? randomBytes(8).toString("hex");
        if (target) {
          if (target.agent !== node.agent) throw new RunStoreError("switch to the branch's provider before restoring it");
          db.prepare("UPDATE conversation_branches SET active=1 WHERE id=?").run(id);
          db.prepare("UPDATE chat_sessions SET session='agent' WHERE run_id=? AND session=?").run(runId,'branch-'+id);
        } else db.prepare("INSERT INTO conversation_branches(id,run_id,parent,items,snapshot,provider,agent,active) VALUES (?,?,?,?,?,?,?,1)").run(id,runId,current.id,JSON.stringify(prefix),JSON.stringify(prefix),'',node.agent);
        db.prepare("UPDATE nodes SET agent_chat_id=?,status='running',finished_at=NULL,activity='idle' WHERE run_id=? AND id='agent'").run(target?.provider ?? '',runId);
        if(!target)db.prepare("UPDATE conversation_branches SET strategy='pending' WHERE id=?").run(id);
        logEvent(runId,NODE_ID,"conversation.branch",{id,parent:current.id,strategy:target ? "restore" : "reconstructed"});
        db.exec("RELEASE store_write");return id;
      } catch(e) {db.exec("ROLLBACK TO store_write; RELEASE store_write");throw e;}
    },
    subscribeWait(target, caller, session, scope, turn) {
      db.prepare("INSERT OR IGNORE INTO wait_subscriptions VALUES (?,?,?,?,?,?)").run(randomBytes(8).toString("hex"),target,caller,session,scope,turn);
      return (db.prepare("SELECT id FROM wait_subscriptions WHERE target=? AND caller=? AND session=? AND scope=? AND turn=?").get(target,caller,session,scope,turn) as {id:string}).id;
    },
    waitSubscriptions() { return db.prepare("SELECT * FROM wait_subscriptions").all() as {id:string;target:string;caller:string;session:string;scope:string;turn:string}[]; },
    completeWait(id, message) {
      db.exec("SAVEPOINT store_write");
      try {
        const row = db.prepare("SELECT * FROM wait_subscriptions WHERE id=?").get(id) as {caller:string;session:string} | undefined;
        if (row) {
          insertMessage.run(row.caller,row.session,"rivet",redact(message),new Date().toISOString(),"queue");
          db.prepare("DELETE FROM wait_subscriptions WHERE id=?").run(id);
          logEvent(row.caller,row.session,"wait.completed",{id});
        }
        db.exec("RELEASE store_write");
      } catch(e) {db.exec("ROLLBACK TO store_write; RELEASE store_write");throw e;}
    },
    getFork(runId) { return forkRecord(runId); },
    inherited(runId) { return prefixFor(runId); },
    createThreads(sourceId, tasks) {
      if (!tasks.length || tasks.length > 8 || tasks.some(task => !task.task.trim() || task.task.length > 16000 || (task.name?.length ?? 0) > 100)) {
        throw new RunStoreError("provide 1–8 tasks, at most 16000 characters each, with optional names up to 100 characters");
      }
      const source = this.loadRun(sourceId);
      if (forkRecord(sourceId)?.detached) throw new RunStoreError("source workspace is detached");
      const rootRun = source.sharedWorkspace ?? source.id;
      return tasks.map(input => {
        const id = forkedRunId();
        const task = input.task.trim();
        const name = input.name?.trim() ?? "";
        const run: Run = {
          id, project: source.project, repo: source.repo, base: source.base, task,
          createdAt: new Date().toISOString(), role: "worker", name, sharedWorkspace: rootRun,
          ...(source.model ? { model: source.model } : {}),
          spec: { ...structuredClone(source.spec ?? {}), terminal: false, chat: true, doneWhen: undefined },
          node: {
            id: NODE_ID, title: name || task.slice(0, 100), prompt: task,
            agent: source.node.agent, branch: source.node.branch, worktree: source.node.worktree,
            status: "pending", attempts: 0, runMode: "chat",
          },
        };
        this.saveRun(run, {
          sourceRun: sourceId, rootRun, position: 0, providerId: "", agent: source.node.agent,
          strategy: "pending", independent: true, items: [],
        });
        return id;
      });
    },
    ownForkWorkspace(runId, path) {
      const fork = forkRecord(runId);
      const run = this.loadRun(runId);
      if (!fork || fork.detached || fork.ownsWorkspace || run.node.status === "running") {
        throw new RunStoreError("handoff requires a stopped shared fork");
      }
      db.exec("SAVEPOINT workspace_handoff");
      try {
        db.prepare("UPDATE nodes SET worktree = ?, branch = ?, status = 'pending', agent_chat_id = '', agent_own_id = NULL WHERE run_id = ?")
          .run(path, branchName(runId, NODE_ID), runId);
        db.prepare("UPDATE thread_forks SET data_json = ? WHERE run_id = ?")
          .run(JSON.stringify({ ...fork, ownsWorkspace: true, items: this.readChat(runId, { limit: 5000 }).items, providerId: "", providerTurn: undefined, strategy: "pending" }), runId);
        logEvent(runId, NODE_ID, "workspace.handoff");
        db.exec("RELEASE workspace_handoff");
      } catch (error) {
        db.exec("ROLLBACK TO workspace_handoff; RELEASE workspace_handoff");
        throw error;
      }
    },
    detachFork(runId) {
      const fork = forkRecord(runId);
      if (!fork) return;
      if (fork.detached) return;
      fork.detached = true;
      db.prepare("UPDATE nodes SET status = CASE WHEN status IN ('pending', 'running') THEN 'escalated' ELSE status END, finished_at = coalesce(finished_at, ?), activity = 'ended' WHERE run_id = ?")
        .run(new Date().toISOString(), runId);
      db.prepare("UPDATE thread_forks SET data_json = ? WHERE run_id = ?").run(JSON.stringify(fork), runId);
      logEvent(runId, NODE_ID, "conversation.detached");
    },
    workspaceForks(owner) {
      return (db.prepare("SELECT run_id FROM thread_forks WHERE root_run = ? AND coalesce(json_extract(data_json, '$.detached'), 0) = 0 AND coalesce(json_extract(data_json, '$.ownsWorkspace'), 0) = 0").all(owner) as { run_id: string }[]).map((r) => r.run_id);
    },
    contextTransfer(source, target, through) {
      const row = db.prepare("SELECT t.id, t.attached, o.delivered_at FROM context_transfers t JOIN outbox o ON o.id = t.message_id WHERE t.source_run = ? AND t.target_run = ? AND t.through_position = ?").get(source, target, through) as { id: string; attached: number; delivered_at: string | null } | undefined;
      return row ? { id: row.id, delivered: row.delivered_at !== null, attached: !!row.attached } : undefined;
    },
    pendingContextSize(target) {
      return Number((db.prepare("SELECT coalesce(sum(length(o.message)), 0) AS size FROM context_transfers t JOIN outbox o ON o.id = t.message_id WHERE t.target_run = ? AND t.attached = 0").get(target) as { size: number }).size);
    },
    listContextTransfers(runId) {
      return db.prepare("SELECT t.id, t.source_run AS sourceRun, t.target_run AS targetRun, t.through_position AS through, CASE WHEN o.delivered_at IS NOT NULL THEN 'delivered' WHEN t.attached = 1 THEN 'queued' ELSE 'pending' END AS delivery FROM context_transfers t JOIN outbox o ON o.id = t.message_id WHERE t.source_run = ? OR t.target_run = ? ORDER BY t.created_at, t.id").all(runId, runId) as { id: string; sourceRun: string; targetRun: string; through: number; delivery: string }[];
    },
    lastTransferPosition(source, target) {
      return Number((db.prepare("SELECT coalesce(max(through_position), 0) AS position FROM context_transfers WHERE source_run = ? AND target_run = ?").get(source, target) as { position: number }).position);
    },
    transferContext(source, target, through, text) {
      const id = randomBytes(8).toString("hex");
      db.exec("SAVEPOINT store_write");
      try {
        const previous = db.prepare("SELECT id FROM context_transfers WHERE source_run = ? AND target_run = ? AND through_position = ?").get(source, target, through) as { id: string } | undefined;
        if (previous) { db.exec("RELEASE store_write"); return { id: previous.id, duplicate: true }; }
        const now = new Date().toISOString();
        const message = db.prepare("INSERT INTO outbox (run_id, node_id, message, from_session, created_at, mode) VALUES (?, 'agent', ?, ?, ?, 'queue')").run(target, redact(text), `${source}-agent`, now);
        db.prepare("INSERT INTO context_transfers (id, source_run, target_run, through_position, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, source, target, through, Number(message.lastInsertRowid), now);
        logEvent(source, NODE_ID, "context.carry_back", { id, target, through });
        logEvent(target, NODE_ID, "context.received", { id, source, through });
        db.exec("RELEASE store_write");
        return { id, duplicate: false };
      } catch (e) { db.exec("ROLLBACK TO store_write; RELEASE store_write"); throw e; }
    },
    waitTurn(runId, turn) {
      const row = db.prepare(`SELECT t.agent_turn AS id, coalesce(t.ended_as, 'working') AS state FROM chat_turns t
        JOIN chat_sessions c ON c.id = t.chat_id
        WHERE c.run_id = ? AND c.session = 'agent' ${turn ? 'AND t.agent_turn = ?' : ''}
        ORDER BY t.began_at DESC, t.rowid DESC LIMIT 1`).get(runId, ...(turn ? [turn] : [])) as { id: string; state: string } | undefined;
      if (turn && !row) throw new RunStoreError(`unknown turn ${turn}`);
      return row;
    },

    searchRuns(query, o) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const limit = Math.min(51, Math.max(1, o.limit));
      const pageSize = Math.min(50, Math.max(1, o.pageSize ?? Math.min(limit, 50)));
      const metadataQuota = pageSize > 1 ? pageSize - Math.max(1, Math.floor(pageSize / 5)) : 1;
      const messageQuota = Math.max(1, pageSize - metadataQuota);
      const indexed = Array.from(q).length >= 3 && !q.includes('\0');
      const messageFilter = indexed ? "AND m.rowid IN (SELECT rowid FROM chat_search WHERE chat_search MATCH @phrase)" : "";
      const timelineFilter = indexed ? "AND t.id IN (SELECT rowid FROM timeline_search WHERE timeline_search MATCH @phrase)" : "";
      type Hit = { runId: string; project: string; title: string; source: string; snippet: string; position: number | null; branchId: string | null; history: string };
      const hits = db.prepare(`WITH prefixes AS (
        SELECT f.run_id AS run_id, NULL AS branch_id, 'inherited' AS history, j.value AS item
        FROM thread_forks f, json_each(f.data_json, '$.items') j
        WHERE NOT EXISTS (SELECT 1 FROM conversation_branches b WHERE b.run_id=f.run_id AND b.active=1)
        UNION ALL
        SELECT b.run_id, b.id, 'inherited', j.value
        FROM conversation_branches b, json_each(b.items) j WHERE b.active=1
        UNION ALL
        SELECT b.run_id, b.id, 'branch', j.value
        FROM conversation_branches b, json_each(b.snapshot) j WHERE b.active=0
      ), hits AS (
        SELECT r.id AS runId, r.project, r.name AS title, 'metadata' AS source,
          r.name || ' ' || r.task || ' branch: ' || n.branch || ' project: ' || r.project || coalesce(' PR: #' || p.number || ' ' || p.url, '') AS snippet,
          NULL AS position, r.created_at AS at, NULL AS branchId, 'metadata' AS history, 0 AS category
        FROM runs r JOIN nodes n ON n.run_id=r.id LEFT JOIN pull_requests p ON p.run_id=r.id
        WHERE instr(lower(r.name || ' ' || r.task || ' ' || n.branch || ' ' || r.project || ' ' || coalesce('#' || p.number || ' ' || p.url, '')), @query)>0
          AND (@project IS NULL OR r.project=@project)
        UNION ALL
        SELECT r.id, r.project, r.name, m.said_by, m.body, m.position, m.created_at, NULL, 'live', 1
        FROM chat_log m JOIN chat_sessions c ON c.id=m.chat_id JOIN runs r ON r.id=c.run_id
        WHERE c.session='agent' AND m.step IS NULL AND m.progress='final' AND instr(lower(m.body),@query)>0
          ${messageFilter} AND (@project IS NULL OR r.project=@project)
        UNION ALL
        SELECT r.id, r.project, r.name, CASE WHEN t.kind='assistant' THEN 'assistant' ELSE 'user' END,
          t.text, t.id, t.at, NULL, 'live', 1
        FROM timeline t JOIN runs r ON r.id=t.run_id JOIN nodes n ON n.run_id=r.id
        WHERE n.run_mode<>'chat' AND t.session='agent' AND t.kind IN ('prompt','message','assistant')
          AND instr(lower(t.text),@query)>0 ${timelineFilter} AND (@project IS NULL OR r.project=@project)
        UNION ALL
        SELECT r.id, r.project, r.name,
          CASE WHEN json_extract(p.item,'$.kind')='assistant' THEN 'assistant' ELSE 'user' END,
          json_extract(p.item,'$.text'), json_extract(p.item,'$.position'),
          coalesce(json_extract(p.item,'$.at'),r.created_at), p.branch_id, p.history, 1
        FROM prefixes p JOIN runs r ON r.id=p.run_id
        WHERE json_extract(p.item,'$.kind') IN ('prompt','message','assistant')
          AND coalesce(json_extract(p.item,'$.streaming'),0)=0
          AND instr(lower(json_extract(p.item,'$.text')),@query)>0
          AND (@project IS NULL OR r.project=@project)
      ), numbered AS (
        SELECT *, row_number() OVER (PARTITION BY category ORDER BY at DESC,runId,history,coalesce(branchId,''),coalesce(position,0) DESC,source) AS ordinal
        FROM hits
      ) SELECT runId,project,title,source,snippet,position,branchId,history FROM numbered
      ORDER BY CASE WHEN category=0
        THEN ((ordinal-1)/@metadataQuota)*@pageSize + ((ordinal-1)%@metadataQuota)
        ELSE ((ordinal-1)/@messageQuota)*@pageSize + @metadataQuota + ((ordinal-1)%@messageQuota)
      END, category,ordinal LIMIT @limit OFFSET @offset`).all({
        '@query': q, '@project': o.project ?? null,
        ...(indexed ? { '@phrase': '"' + q.replace(/"/g, '""') + '"' } : {}),
        '@metadataQuota': metadataQuota, '@messageQuota': messageQuota, '@pageSize': pageSize,
        '@limit': limit, '@offset': o.offset ?? 0,
      }) as Hit[];
      return hits.map(h => {
        const text = redact(h.snippet);
        const at = Math.max(0, text.toLowerCase().indexOf(q) - 80);
        return { runId: h.runId, project: h.project, title: redact(h.title), source: h.source, history: h.history,
          snippet: `${at ? '…' : ''}${text.slice(at, at + 320)}${text.length > at + 320 ? '…' : ''}`,
          ...(h.position === null ? {} : { position: h.position }), ...(h.branchId ? { branchId: h.branchId } : {}) };
      });
    },

    readEvents(runId, o) {
      type Row = { id: number; node_id: string | null; type: string; data: string; at: string };
      return (db.prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?").all(runId, o.after ?? 0, o.limit) as Row[])
        .map((r) => ({ position: Number(r.id), type: r.type, data: JSON.parse(r.data) as Record<string, unknown>, at: r.at, ...(r.node_id !== null ? { nodeId: r.node_id } : {}) }));
    },

    recordChat(runId, session, events, receipt) {
      if (receipt) {
        const prior = db.prepare("SELECT outcome FROM chat_receipts WHERE run_id = ? AND session = ? AND id = ?").get(runId, session, receipt.id) as { outcome: string } | undefined;
        if (prior) return JSON.parse(prior.outcome) as ChatOutcome;
      }
      const run = selectRun.get(runId) as { project: string } | undefined;
      if (!run) throw new RunStoreError(`no run ${runId}`);
      const now = new Date().toISOString();
      const out: ChatOutcome = {};
      db.exec("SAVEPOINT store_write");
      try {
        let conv = db.prepare("SELECT id FROM chat_sessions WHERE run_id = ? AND session = ?").get(runId, session) as { id: string } | undefined;
        if (!conv) {
          conv = { id: randomBytes(8).toString("hex") };
          db.prepare("INSERT INTO chat_sessions (id, run_id, session, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
            .run(conv.id, runId, session, now, now);
        }
        const c = conv.id;
        const inheritedMax = prefixFor(runId).at(-1)?.position ?? 0;
        db.prepare("UPDATE chat_sessions SET next_position = max(next_position, ?) WHERE id = ?").run(inheritedMax + 1, c);
        const nextSeq = () => Number((db.prepare("UPDATE chat_sessions SET next_position = next_position + 1, updated_at = ? WHERE id = ? RETURNING next_position - 1 AS position")
          .get(now, c) as { position: number }).position);
        const turnRow = (agentTurnId?: string) => agentTurnId
          ? (db.prepare("SELECT id FROM chat_turns WHERE chat_id = ? AND agent_turn = ?").get(c, agentTurnId) as { id: string } | undefined)?.id ?? null
          : null;
        // State the partial-index predicate explicitly: SQLite cannot infer that a
        // bound provider item id is nonempty, otherwise large imports scan each prefix.
        const namedMessage = db.prepare("SELECT id FROM chat_log WHERE chat_id=? AND step IS NULL AND item_key=? AND item_key<>''");
        const emptyMessage = db.prepare("SELECT id FROM chat_log WHERE chat_id=? AND step IS NULL AND item_key=''");
        const messageRow = (itemId: string) => (itemId ? namedMessage.get(c, itemId) : emptyMessage.get(c)) as { id: string } | undefined;
        for (const e of events) {
          if (e.type === "conversation") {
            out.conversationId = e.id;
            if(session===NODE_ID && e.forkStrategy)db.prepare("UPDATE conversation_branches SET strategy=? WHERE run_id=? AND active=1").run(e.forkStrategy,runId);
            const fork = forkRecord(runId);
            if (fork && e.forkStrategy) {
              fork.strategy = e.forkStrategy;
              db.prepare("UPDATE thread_forks SET data_json = ? WHERE run_id = ?").run(JSON.stringify(fork), runId);
              logEvent(runId, NODE_ID, "conversation.initialized", { strategy: fork.strategy });
            }
            if (session === NODE_ID) {
              db.prepare("UPDATE nodes SET agent_chat_id = ? WHERE run_id = ? AND id = ?").run(e.id, runId, NODE_ID);
              logEvent(runId, NODE_ID, "chat.conversation", { id: e.id });
              // Its agent keeps the conversation on disk too, so usage is counted from it as for a
              // terminal session: complete even when a turn is cut short.
              insertConversation.run(e.id, now, runId, NODE_ID);
            }
          } else if (e.type === "turn") {
            const id = turnRow(e.turnId);
            if (e.state === "working") {
              const agent = (db.prepare("SELECT agent FROM nodes WHERE run_id = ? AND id = ?").get(runId, NODE_ID) as { agent: string } | undefined)?.agent ?? "";
              if (!id) db.prepare("INSERT INTO chat_turns (id, chat_id, agent_turn, began_at, agent, agent_chat_id) VALUES (?, ?, ?, ?, ?, (SELECT agent_chat_id FROM nodes WHERE run_id = ? AND id = 'agent'))")
                .run(randomBytes(8).toString("hex"), c, e.turnId, now, agent, runId);
              out.activity = "busy";
            } else {
              if (id) db.prepare("UPDATE chat_turns SET ended_as = ?, problem = ?, ended_at = ? WHERE id = ?").run(e.state, e.error ?? "", now, id);
              out.activity = "idle";
            }
          } else if (e.type === "message") {
            let text = redact(e.text);
            if (e.role === "user" && !e.itemId.startsWith("rivet-") && !messageRow(e.itemId)) {
              const hostPrompts = db.prepare("SELECT id,body AS text FROM chat_log WHERE chat_id=? AND said_by='user' AND item_key LIKE 'rivet-%' ORDER BY position").all(c) as {id:string;text:string}[];
              const host = hostPrompts.find(p=>text === p.text || text.endsWith("\n\n"+p.text));
              if (host) {
                db.prepare("UPDATE chat_log SET item_key=?,turn_id=? WHERE id=?").run(e.itemId,turnRow(e.turnId),host.id);
                text = host.text;
              }
            }
            const found = messageRow(e.itemId);
            const progress = e.streaming ? "writing" : "final";
            if (found) db.prepare("UPDATE chat_log SET body = ?, progress = ?, updated_at = ? WHERE id = ?").run(text, progress, now, found.id);
            else db.prepare(`INSERT INTO chat_log (id, chat_id, turn_id, position, said_by, body, progress, item_key, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomBytes(8).toString("hex"), c, turnRow(e.turnId), nextSeq(), e.role, text, progress, e.itemId, now, now);
          } else if(e.type==="history") {
            const existing=db.prepare("SELECT id,said_by AS role,body AS text,progress='writing' AS streaming,item_key AS providerId FROM chat_log WHERE chat_id=? AND step IS NULL ORDER BY position").all(c) as {id:string;role:string;text:string;streaming:number;providerId:string}[];
            const used=new Set<string>();
            for(const [index,item] of e.items.entries()){
              const whole=redact(item.text);
              const providerId="acp-history-"+createHash("sha256").update(JSON.stringify([e.providerId,index,item.role,whole])).digest("hex");
              const exact=existing.find(row=>!used.has(row.id)&&row.providerId===providerId);
              const matched=exact??existing.find(row=>!used.has(row.id)&&row.role===item.role&&(row.text===whole || item.role==="user"&&whole.endsWith("\n\n"+row.text) || item.role==="assistant"&&row.streaming===1&&row.text.length>0&&whole.startsWith(row.text)));
              if(matched){
                used.add(matched.id);
                if(matched.streaming)db.prepare("UPDATE chat_log SET body=?,progress='final',updated_at=? WHERE id=?").run(whole,now,matched.id);
              }else{
                const id=randomBytes(8).toString("hex");
                db.prepare("INSERT INTO chat_log(id,chat_id,position,said_by,body,progress,item_key,created_at,updated_at) VALUES (?,?,?,?,?,'final',?,?,?)").run(id,c,nextSeq(),item.role,whole,providerId,now,now);
                existing.push({id,role:item.role,text:whole,streaming:0,providerId});used.add(id);
              }
            }
            out.activity="idle";
            logEvent(runId,session,"chat.history-reconciled",{items:e.items.length,provider:e.providerId,positionPolicy:"append missing entries; preserve existing positions"});
          } else if (e.type === "usage") {
            // add: one turn's use on top of the totals; set: the agent's own totals. Context
            // figures are always the latest.
            const op = (col: string, v: number | undefined) => v === undefined ? "" : e.mode === "add" ? `${col} = COALESCE(${col}, 0) + ${Math.round(v)}` : `${col} = ${Math.round(v)}`;
            const sets = [op("tokens_in", e.input), op("tokens_out", e.output), op("tokens_cached", e.cached), op("tokens_total", e.total),
              e.contextUsed !== undefined ? `context_filled = ${Math.round(e.contextUsed)}` : "", e.contextWindow !== undefined ? `context_size = ${Math.round(e.contextWindow)}` : ""].filter(Boolean);
            if (sets.length) db.prepare(`UPDATE chat_sessions SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(now, c);
          } else {
            const key = e.requestId ? "question_key" : "item_key";
            const keyValue = e.requestId ?? e.itemId ?? "";
            const detail = e.output !== undefined || e.tool !== undefined ? JSON.stringify({ ...(e.tool ? { tool: e.tool } : {}), ...(e.output !== undefined ? { output: redact(e.output) } : {}) }) : "";
            const found = keyValue ? db.prepare(`SELECT id, body AS summary FROM chat_log WHERE chat_id = ? AND step IS NOT NULL AND ${key} = ?`).get(c, keyValue) as { id: string; summary: string } | undefined : undefined;
            const summary = redact(e.summary);
            if (found) db.prepare("UPDATE chat_log SET progress = ?, body = ?, details = CASE WHEN ? = '' THEN details ELSE ? END, updated_at = ? WHERE id = ?")
              .run(e.status, e.kind === "question" && e.status === "answered" ? `${found.summary} (${summary})` : summary || found.summary, detail, detail, now, found.id);
            else db.prepare(`INSERT INTO chat_log (id, chat_id, turn_id, position, step, progress, body, details, question_key, item_key, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomBytes(8).toString("hex"), c, turnRow(e.turnId), nextSeq(), e.kind, e.status, summary, detail,
                e.requestId ?? "", e.requestId ? "" : e.itemId ?? "", now, now);
            if (e.kind === "question" && e.status === "waiting") {
              out.activity = "approval";
              out.question = { tool: e.tool ?? "tool", detail: summary.replace(/^[^:]*: /, ""), requestId: e.requestId ?? "" };
            } else if (e.kind === "question" && e.status === "answered") {
              out.question = null;
              out.activity = "busy";
            }
          }
        }
        if (receipt) {
          for (const id of receipt.accepted) db.prepare("UPDATE outbox SET delivered_at = coalesce(delivered_at, ?) WHERE id = ? AND run_id = ? AND node_id = ?").run(now, id, runId, session);
          db.prepare("INSERT INTO chat_receipts(run_id,session,id,outcome) VALUES (?,?,?,?)").run(runId, session, receipt.id, JSON.stringify(out));
        }
        db.exec("RELEASE store_write");
      } catch (e) {
        db.exec("ROLLBACK TO store_write; RELEASE store_write");
        throw e;
      }
      return out;
    },

    lastTurnError(runId) {
      const r = db.prepare(`SELECT t.ended_as AS state, t.problem AS error FROM chat_turns t JOIN chat_sessions c ON c.id = t.chat_id
        WHERE c.run_id = ? AND c.session = ? ORDER BY t.rowid DESC LIMIT 1`).get(runId, NODE_ID) as { state: string; error: string } | undefined;
      return r?.state === "failed" && r.error ? r.error : null;
    },

    chatUsage(runId, session = NODE_ID) {
      const r = db.prepare(`SELECT tokens_in AS input, tokens_out AS output, tokens_cached AS cached, tokens_total AS total,
        context_filled AS used, context_size AS window FROM chat_sessions WHERE run_id = ? AND session = ?`).get(runId, session) as
        { input: number | null; output: number | null; cached: number | null; total: number | null; used: number | null; window: number | null } | undefined;
      if (!r || (r.total === null && r.used === null)) return null;
      return { input: Number(r.input ?? 0), output: Number(r.output ?? 0), cached: Number(r.cached ?? 0), total: Number(r.total ?? 0),
        ...(r.used !== null ? { contextUsed: Number(r.used) } : {}), ...(r.window !== null ? { contextWindow: Number(r.window) } : {}) };
    },

    recordProviderLines(runId, session, lines) {
      const conv = db.prepare("SELECT id FROM chat_sessions WHERE run_id = ? AND session = ?").get(runId, session) as { id: string } | undefined;
      if (!conv) return 0;
      const insert = db.prepare("INSERT INTO chat_raw (chat_id, kind, line, seen_at) VALUES (?, ?, ?, ?)");
      const now = new Date().toISOString();
      let kept = 0;
      db.exec("SAVEPOINT store_write");
      try {
        for (const line of lines) {
          let m: { method?: unknown; id?: unknown; result?: unknown; error?: unknown };
          try { m = JSON.parse(line); } catch { continue; }
          // A reply to Rivet's own call has no method: it is named after what it answers.
          const method = typeof m.method === "string" ? m.method : m.error !== undefined ? "error" : "result";
          kept += Number(insert.run(conv.id, method, redact(line), now).changes);
        }
        db.exec("RELEASE store_write");
      } catch (e) {
        db.exec("ROLLBACK TO store_write; RELEASE store_write");
        throw e;
      }
      return kept;
    },

    providerLines(runId, o) {
      const conv = db.prepare("SELECT id FROM chat_sessions WHERE run_id = ? AND session = ?").get(runId, o.session ?? NODE_ID) as { id: string } | undefined;
      if (!conv) return [];
      type Row = { id: number; method: string; payload_json: string; received_at: string };
      return (db.prepare("SELECT position AS id, kind AS method, line AS payload_json, seen_at AS received_at FROM chat_raw WHERE chat_id = ? AND position > ? ORDER BY position LIMIT ?")
        .all(conv.id, o.after ?? 0, o.limit) as Row[]).map((r) => ({ position: Number(r.id), method: r.method, payload: r.payload_json, at: r.received_at }));
    },

    readChat(runId, o) {
      const conv = db.prepare("SELECT id FROM chat_sessions WHERE run_id = ? AND session = ?").get(runId, o.session ?? NODE_ID) as { id: string } | undefined;
      const inherited = o.session && o.session !== NODE_ID ? [] : prefixFor(runId);
      if (!conv) {
        const shown = inherited.filter((i) => !o.kinds || o.kinds.includes(i.kind));
        return { total: shown.length, items: shown.filter((i) => i.position > (o.after ?? 0)).slice(0, o.limit) };
      }
      type Row = { sequence: number; source: string; role: string | null; kind: string | null; status: string | null; text: string; detail: string; at: string; streaming: number; agent: string | null; turn_id: string | null; provider: string | null; item_id: string | null };
      const rows = db.prepare(`
        SELECT l.position AS sequence, CASE WHEN l.step IS NULL THEN 'message' ELSE 'activity' END AS source, l.said_by AS role, l.step AS kind,
          l.progress AS status, l.body AS text, l.details AS detail, l.created_at AS at, l.step IS NULL AND l.progress = 'writing' AS streaming,
          CASE WHEN l.step IS NULL THEN t.agent END AS agent, CASE WHEN l.step IS NULL THEN t.agent_turn END AS turn_id,
          CASE WHEN l.step IS NULL THEN t.agent_chat_id END AS provider, CASE WHEN l.step IS NULL THEN l.item_key END AS item_id
        FROM chat_log l LEFT JOIN chat_turns t ON t.id = l.turn_id WHERE l.chat_id = ? ORDER BY l.position`).all(conv.id) as Row[];
      let firstUser = !inherited.some((i) => i.kind === "prompt" || i.kind === "message");
      const all: TimelineItem[] = [...inherited];
      for (const r of rows) {
        const base = { position: Number(r.sequence), session: o.session ?? NODE_ID, at: r.at };
        if (r.source === "message") {
          const kind: TimelineKind = r.role === "assistant" ? "assistant" : firstUser ? "prompt" : "message";
          if (r.role === "user") firstUser = false;
          all.push({ ...base, kind, text: r.text, ...(r.streaming ? { streaming: true } : {}), ...(r.agent ? { agent: r.agent } : {}), ...(r.turn_id ? { turnId: r.turn_id } : {}), ...(r.provider ? { agentChatId: r.provider } : {}), ...(r.item_id ? { itemId: r.item_id } : {}) });
          continue;
        }
        const detail = r.detail ? JSON.parse(r.detail) as { tool?: string; output?: string } : {};
        if (r.kind === "shell" || r.kind === "edit") {
          const failed = r.status === "failed" ? " (failed)" : "";
          all.push({ ...base, kind: "tool", tool: detail.tool ?? r.kind, text: `${r.text}${failed}${detail.output ? `\n${detail.output}` : ""}` });
        } else if (r.kind === "question") all.push({ ...base, kind: "event", text: `asked to use ${r.text}${r.status === "waiting" ? " (waiting for an answer)" : ""}` });
        else if (r.kind !== "tokens") all.push({ ...base, kind: "event", text: `${r.kind}: ${r.text}` });
      }
      const kinds = new Set(o.kinds ?? TIMELINE_KINDS);
      const shown = all.filter((i) => kinds.has(i.kind));
      const after = o.after ?? 0;
      return { total: shown.length, items: shown.filter((i) => i.position > after).slice(0, o.limit) };
    },

    environmentInstructions() {
      const row = db.prepare("SELECT instructions FROM environment_preferences WHERE id=1").get() as { instructions: string } | undefined;
      return row?.instructions ?? "";
    },

    setEnvironmentInstructions(text) {
      db.prepare("INSERT INTO environment_preferences VALUES (1,?) ON CONFLICT(id) DO UPDATE SET instructions=excluded.instructions").run(text);
    },

    projectMetadata(id) {
      const record = db.prepare("SELECT repo,title,instructions,scripts,deleted_at FROM registered_projects WHERE id=?").get(id) as
        { repo: string; title: string; instructions: string; scripts: string; deleted_at: string | null } | undefined;
      if (record) return record.deleted_at ? null : { id, repo: record.repo, title: record.title, instructions: record.instructions, scripts: JSON.parse(record.scripts) };
      const roots = db.prepare("SELECT DISTINCT repo FROM runs WHERE project=? LIMIT 2").all(id) as { repo: string }[];
      if (roots.length > 1) return null;
      return roots[0] ? { id, repo: roots[0].repo, title: id, instructions: "", scripts: [] } : null;
    },

    projectDeleted(id) {
      return !!db.prepare("SELECT 1 FROM registered_projects WHERE id=? AND deleted_at IS NOT NULL").get(id);
    },

    saveProject(project) {
      assertProjectId(project.id);
      if (db.prepare("SELECT 1 FROM runs WHERE project=? AND repo<>?").get(project.id, project.repo)) throw new RunStoreError("project ID is shared by multiple repository paths");
      const existing = this.projectMetadata(project.id);
      if (existing && existing.repo !== project.repo) throw new RunStoreError("project ID belongs to a different repository");
      db.prepare("INSERT INTO registered_projects VALUES (?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET repo=excluded.repo,title=excluded.title,instructions=excluded.instructions,scripts=excluded.scripts,deleted_at=NULL")
        .run(project.id, project.repo, project.title, project.instructions, JSON.stringify(project.scripts));
    },

    deleteProject(id) {
      const project = this.projectMetadata(id);
      if (!project) throw new RunStoreError("unknown project");
      if (db.prepare("SELECT 1 FROM nodes n JOIN runs r ON r.id=n.run_id WHERE r.project=? AND n.status IN ('pending','running')").get(id)) throw new RunStoreError("stop the project's active and pending runs first");
      const ids = "SELECT id FROM runs WHERE project=?";
      db.prepare(`DELETE FROM context_transfers WHERE source_run IN (${ids}) OR target_run IN (${ids})`).run(id, id);
      db.prepare(`DELETE FROM thread_forks WHERE run_id IN (${ids})`).run(id);
      db.prepare("DELETE FROM runs WHERE project=?").run(id);
      db.prepare("DELETE FROM project_config WHERE project=?").run(id);
      db.prepare("DELETE FROM routines WHERE project=?").run(id);
      db.prepare("DELETE FROM snippets WHERE project=?").run(id);
      db.prepare("INSERT INTO registered_projects VALUES (?,?,?,'','[]',?) ON CONFLICT(id) DO UPDATE SET instructions='',scripts='[]',deleted_at=excluded.deleted_at")
        .run(id, project.repo, project.title, new Date().toISOString());
    },

    listProjects() {
      const rows = db.prepare("SELECT project FROM runs UNION SELECT id FROM registered_projects WHERE deleted_at IS NULL ORDER BY 1").all() as { project: string }[];
      return rows.map(row => row.project);
    },

    readTimeline(runId, o) {
      const kinds = o.kinds ?? TIMELINE_KINDS;
      const marks = kinds.map(() => "?").join(", ");
      const where = `run_id = ? AND kind IN (${marks})${o.session ? " AND session = ?" : ""}`;
      const args = [runId, ...kinds, ...(o.session ? [o.session] : [])];
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM timeline WHERE ${where}`).get(...args) as { n: number }).n;
      type Row = { id: number; session: string; kind: TimelineKind; tool: string | null; text: string; at: string };
      const rows = db.prepare(`SELECT * FROM timeline WHERE ${where} AND id > ? ORDER BY id LIMIT ?`).all(...args, o.after ?? 0, o.limit) as Row[];
      return {
        total: Number(total),
        items: rows.map((r) => ({ position: Number(r.id), session: r.session, kind: r.kind, text: r.text, at: r.at, ...(r.tool !== null ? { tool: r.tool } : {}) })),
      };
    },

    saveSnippet(snippet) {
      db.prepare(`INSERT INTO snippets (project, name, type, text, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (project, name) DO UPDATE SET type = excluded.type, text = excluded.text, updated_at = excluded.updated_at`)
        .run(snippet.project, snippet.name, snippet.type, snippet.text, snippet.updatedAt);
    },

    listSnippets(project) {
      type Row = { project: string; name: string; type: Snippet["type"]; text: string; updated_at: string };
      return (db.prepare("SELECT * FROM snippets WHERE project = ? ORDER BY name").all(project) as Row[])
        .map((r) => ({ project: r.project, name: r.name, type: r.type, text: r.text, updatedAt: r.updated_at }));
    },

    deleteSnippet(project, name) {
      return db.prepare("DELETE FROM snippets WHERE project = ? AND name = ?").run(project, name).changes > 0;
    },

    startReview(runId, sha, trigger) {
      logEvent(runId, "review", "review.started", { sha, trigger });
      return Number(db.prepare("INSERT INTO reviews (run_id, sha, trigger, status, created_at) VALUES (?, ?, ?, 'running', ?)")
        .run(runId, sha, trigger, new Date().toISOString()).lastInsertRowid);
    },

    endReview(id, f) {
      const ended = db.prepare("UPDATE reviews SET status = ?, verdict = ?, body = ?, posted_review_id = ? WHERE id = ? AND status = 'running'")
        .run(f.status, f.verdict ?? null, f.body ?? null, f.postedReviewId ?? null, id).changes;
      const row = ended ? db.prepare("SELECT run_id FROM reviews WHERE id = ?").get(id) as { run_id: string } | undefined : undefined;
      if (row) logEvent(row.run_id, "review", "review.ended", { status: f.status, verdict: f.verdict ?? null });
    },

    reviewsOf(runId) {
      type Row = { id: number; run_id: string; sha: string; trigger: Review["trigger"]; status: Review["status"]; verdict: Review["verdict"] | null;
        body: string | null; posted_review_id: number | null; created_at: string };
      return (db.prepare("SELECT * FROM reviews WHERE run_id = ? ORDER BY id").all(runId) as Row[]).map((r) => ({
        id: Number(r.id), runId: r.run_id, sha: r.sha, trigger: r.trigger, status: r.status, createdAt: r.created_at,
        ...(r.verdict !== null ? { verdict: r.verdict } : {}), ...(r.body !== null ? { body: r.body } : {}),
        ...(r.posted_review_id !== null ? { postedReviewId: Number(r.posted_review_id) } : {}),
      }));
    },

    prLinks(runId) {
      return db.prepare("SELECT number,url,status,handled FROM pr_links WHERE run_id=? ORDER BY number").all(runId) as PrLink[];
    },

    addPrLink(runId, pr) {
      db.prepare("INSERT INTO pr_links(run_id,number,url,status) VALUES (?,?,?,?) ON CONFLICT(run_id,number) DO UPDATE SET url=excluded.url,status=excluded.status").run(runId, pr.number, pr.url, pr.status);
    },

    updatePrLink(runId, number, status, handled) {
      db.prepare("UPDATE pr_links SET status=?, handled=coalesce(?,handled) WHERE run_id=? AND number=?").run(status, handled ?? null, runId, number);
    },

    removePrLink(runId, number) {
      return db.prepare("DELETE FROM pr_links WHERE run_id=? AND number=?").run(runId, number).changes > 0;
    },

    readReviewNotes(runId, number) {
      const row = db.prepare("SELECT text FROM review_notes WHERE run_id=? AND number=?").get(runId, number) as { text: string } | undefined;
      return row?.text ?? null;
    },

    writeReviewNotes(runId, guides) {
      const save = db.prepare("INSERT INTO review_notes (run_id, number, text) VALUES (?,?,?) ON CONFLICT(run_id,number) DO UPDATE SET text=excluded.text");
      for (const guide of guides) save.run(runId, guide.number, redact(guide.text));
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
      logEvent(runId, null, "pr", { number: pr.number, handled: pr.handled ?? null });
    },

    clearPr(runId) {
      if (db.prepare("DELETE FROM pull_requests WHERE run_id = ?").run(runId).changes) logEvent(runId, null, "pr", { number: null });
    },

    getEndOnMerge(runId) {
      const row = db.prepare("SELECT end_on_merge AS t FROM runs WHERE id = ?").get(runId) as { t: number } | undefined;
      return Number(row?.t ?? 0) === 1;
    },

    setEndOnMerge(runId, terminate) {
      const changed = db.prepare("UPDATE runs SET end_on_merge = ? WHERE id = ?").run(terminate ? 1 : 0, runId).changes;
      if (Number(changed) === 0) throw new RunStoreError(`unknown run ${runId}`);
    },

    lifecycleState(runId, key) {
      const row = db.prepare("SELECT value FROM lifecycle_state WHERE run_id=? AND key=?").get(runId,key) as {value:string}|undefined;
      return row ? JSON.parse(row.value) : {};
    },
    saveLifecycleState(runId,key,value) {
      db.prepare("INSERT INTO lifecycle_state VALUES (?,?,?) ON CONFLICT(run_id,key) DO UPDATE SET value=excluded.value").run(runId,key,JSON.stringify(value));
    },
    getConfig(project) {
      return Object.fromEntries((selectConfig.all(project) as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    },

    setConfig(project, key, value) {
      assertProjectId(project);
      if (value === null) deleteConfig.run(project, key);
      else upsertConfig.run(project, key, value);
    },

    changeCount() {
      return Number((db.prepare("SELECT total_changes() AS n").get() as { n: number | bigint }).n);
    },
    close() {
      db.close();
    },
  };
  try { return journalStore(db,data,store); } catch(error) {db.close();throw error;}
}
