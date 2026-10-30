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
  // The model asked for when it was started; otherwise the project's worker.model.
  model?: string;
  // The issue the task came from, in the run's own repository; its pull request closes it.
  issue?: number;
  // A task file's own definition of done, limits and guardrails for this run.
  spec?: TaskSpec;
  sharedWorkspace?: string;
  node: Node;
};

export type ConversationBranch = { id: string; parent: string | null; items: TimelineItem[]; snapshot: TimelineItem[]; provider: string; agent: string; active: boolean; strategy:string };
export type Store = {
  organizeRun(runId:string,patch:{name?:string;archived?:boolean;group?:string}):void;
  organization(runId:string):{archivedAt:string|null;group:string};
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
  setActivity(runId: string, nodeId: string, state: ActivityState | null, agentSessionId?: string): boolean;
  // A hook from the agent itself: activity, the first-signal time for this launch, and the
  // agent's conversation id (kept for every launch, so usage counts retries too).
  recordSignal(runId: string, nodeId: string, state: ActivityState | null, agentSessionId?: string): boolean;
  // A launch: idle until the agent's hooks say otherwise; it must prove its signal again.
  markLaunched(runId: string, nodeId: string, active?: boolean): void;
  // Every agent conversation a run's nodes have had.
  conversations(runId: string): { nodeId: string; agent: string; id: string }[];
  createReport(runId: string, nodeId: string, kind: "done" | "stuck" | "needs-input", message?: string): number | null;
  // mode: steer (typed in as soon as the agent can take it), queue (only once it is idle),
  // interrupt (its current turn is stopped first).
  queueMessage(runId: string, nodeId: string, message: string, from?: string, mode?: SendMode): number | null;
  undeliveredMessages(runId: string, nodeId: string): { id: number; message: string; mode: SendMode }[];
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
  saveAutomation(a: Automation): void;
  listAutomations(project?: string): Automation[];
  deleteAutomation(id: string): boolean;
  recordAutomationRun(r: Omit<AutomationRun, "id">): void;
  automationRuns(automationId: string): AutomationRun[];
  // A project's cues, by name.
  saveCue(cue: Cue): void;
  // A session's timeline (session: agent, review or partner). A prompt that repeats the
  // session's recent prompts or messages is the same one seen twice (Rivet and a hook) and is skipped.
  addTimeline(runId: string, session: string, entries: TimelineEntry[]): void;
  // Removes the timelines of a project's runs whose sessions all finished before a time;
  // returns how many entries went.
  pruneTimeline(project: string, before: string): number;
  // Every project that has runs.
  listProjects(): string[];
  // A run's state changes after a position, oldest first.
  searchRuns(query: string, o: { project?: string; limit: number }): { runId: string; project: string; title: string; source: string; snippet: string; position?: number }[];
  waitTurn(runId: string, turn?: string): { id: string; state: string } | undefined;
  readEvents(runId: string, o: { after?: number; limit: number }): RunEvent[];
  // Folds a chat session's events into its conversation; returns what they mean for the
  // session: its new activity, and the question it waits on (null once answered).
  recordChat(runId: string, session: string, events: ChatEvent[], receipt?: { id: string; accepted: number[] }): ChatOutcome;
  // A chat session's conversation as timeline entries, in the order they happened.
  readChat(runId: string, o: { after?: number; limit: number; kinds?: TimelineKind[]; session?: string }): { items: TimelineItem[]; total: number };
  chatUsage(runId: string, session?: string): ChatUsage | null;
  // Keeps the agent's own lines as they came (a protocol message each).
  recordProviderLines(runId: string, session: string, lines: string[]): number;
  providerLines(runId: string, o: { after?: number; limit: number; session?: string }): { position: number; method: string; payload: string; at: string }[];
  // Entries after a position, oldest first; kinds narrows them (the messages view).
  readTimeline(runId: string, o: { after?: number; limit: number; kinds?: TimelineKind[]; session?: string }): { items: TimelineItem[]; total: number };
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

// A prompt run on a schedule: each time it comes round, a worker or orchestrator starts.
export type Automation = {
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

// One time an automation came round: the run it started, or why it could not.
export type AutomationRun = { id: number; automationId: string; scheduledFor: string; runId?: string; error?: string; createdAt: string };

export const SEND_MODES = ["steer", "queue", "interrupt"] as const;
export type SendMode = (typeof SEND_MODES)[number];

export type ForkRecord = { sourceRun: string; rootRun: string; position: number; providerId: string; providerTurn?: string; agent: string; strategy: "pending" | "native" | "reconstructed"; detached?: boolean; items: TimelineItem[] };
export type TimelineItem = { position: number; session: string; kind: TimelineKind; tool?: string; text: string; at: string; streaming?: boolean; agent?: string; turnId?: string; providerConversationId?: string };
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
  agentSessionId?: string | null;
  sessionMode?: Node["sessionMode"];
  providerConversationId?: string | null;
};

const UPDATE_COLUMNS: Record<keyof NodeUpdate, string> = {
  status: "status", attempts: "attempts", summary: "summary", finishedAt: "finished_at", prompt: "prompt", prStatus: "pr_status",
  agent: "agent", agentSessionId: "agent_session_id", sessionMode: "session_mode", providerConversationId: "provider_conversation_id",
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

// Chat sessions: how each session runs, and the conversation of a chat session (its
// turns, readable messages and activities), kept by Rivet.
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
ALTER TABLE chat_turns ADD COLUMN provider_conversation_id TEXT NOT NULL DEFAULT '';
` });

MIGRATIONS.push({ version: 21, sql: `
ALTER TABLE context_transfers ADD COLUMN attached INTEGER NOT NULL DEFAULT 0 CHECK (attached IN (0,1));
` });

MIGRATIONS.push({ version: 20, sql: `
CREATE VIRTUAL TABLE chat_search USING fts5(text, content='chat_messages', content_rowid='rowid', tokenize='trigram');
INSERT INTO chat_search(rowid, text) SELECT rowid, text FROM chat_messages WHERE streaming = 0;
CREATE TRIGGER chat_search_insert AFTER INSERT ON chat_messages WHEN new.streaming = 0 BEGIN
  INSERT INTO chat_search(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER chat_search_update AFTER UPDATE OF text, streaming ON chat_messages BEGIN
  INSERT INTO chat_search(chat_search, rowid, text) SELECT 'delete', old.rowid, old.text WHERE old.streaming = 0;
  INSERT INTO chat_search(rowid, text) SELECT new.rowid, new.text WHERE new.streaming = 0;
END;
CREATE TRIGGER chat_search_delete AFTER DELETE ON chat_messages WHEN old.streaming = 0 BEGIN
  INSERT INTO chat_search(chat_search, rowid, text) VALUES ('delete', old.rowid, old.text);
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
ALTER TABLE chat_turns ADD COLUMN agent TEXT NOT NULL DEFAULT '';
` });

MIGRATIONS.push({ version: 17, sql: `
ALTER TABLE nodes ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'terminal' CHECK (session_mode IN ('terminal', 'chat'));
ALTER TABLE nodes ADD COLUMN provider_conversation_id TEXT NOT NULL DEFAULT '';
CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('session', 'project')),
  project TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  session TEXT,
  latest_sequence INTEGER NOT NULL DEFAULT 0,
  -- Token use and how full the context is, as the agent last said.
  context_used INTEGER,
  context_window INTEGER,
  usage_input_tokens INTEGER,
  usage_output_tokens INTEGER,
  usage_cached_tokens INTEGER,
  usage_total_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'session' AND run_id IS NOT NULL AND session IS NOT NULL) OR (scope = 'project' AND run_id IS NULL))
);
CREATE UNIQUE INDEX chat_conversations_session ON chat_conversations (run_id, session) WHERE run_id IS NOT NULL;
CREATE TABLE chat_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  provider_turn_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'interrupted', 'failed')),
  error_message TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX chat_turns_conversation ON chat_turns (conversation_id, requested_at);
CREATE UNIQUE INDEX chat_turns_provider ON chat_turns (conversation_id, provider_turn_id) WHERE provider_turn_id <> '';
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES chat_turns(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  origin TEXT NOT NULL CHECK (origin IN ('human', 'automation', 'daemon', 'provider')),
  text TEXT NOT NULL DEFAULT '',
  -- A reply still being written: its text grows and revision goes up each time.
  streaming INTEGER NOT NULL DEFAULT 0,
  provider_item_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence)
);
CREATE UNIQUE INDEX chat_messages_provider_item ON chat_messages (conversation_id, provider_item_id) WHERE provider_item_id <> '';
CREATE TABLE chat_activities (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES chat_turns(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('command', 'file_change', 'plan', 'reasoning', 'approval', 'usage', 'error', 'system')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'pending', 'resolved')),
  summary TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  provider_item_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence)
);
CREATE UNIQUE INDEX chat_activities_provider_item ON chat_activities (conversation_id, provider_item_id) WHERE provider_item_id <> '';
CREATE UNIQUE INDEX chat_activities_request ON chat_activities (conversation_id, request_id) WHERE request_id <> '';
CREATE INDEX chat_activities_pending ON chat_activities (conversation_id, kind, status);
-- Every line the agent wrote, as it came: the evidence when Rivet's reading of it is wrong.
-- Never shown as the conversation and never given back to an agent.
CREATE TABLE chat_provider_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE UNIQUE INDEX chat_provider_events_dedupe ON chat_provider_events (conversation_id, provider_event_id) WHERE provider_event_id <> '';
CREATE INDEX chat_provider_events_replay ON chat_provider_events (conversation_id, id);
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
CREATE TABLE automations (
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
CREATE TABLE automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  run_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
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
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
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
  role: string; name: string; orchestrator: string | null; model: string | null; issue: number | null; spec: string | null;
};
type NodeRow = {
  id: string; parent_id: string | null; depth: number; kind: string; title: string; prompt: string;
  files: string; agent: string; branch: string; worktree: string; status: string; attempts: number;
  summary: string | null; activity: string | null; agent_session_id: string | null; pr_status: string | null;
  activity_at: string | null; finished_at: string | null; started_at: string | null; first_signal_at: string | null;
  shared: string; session_mode: string; provider_conversation_id: string;
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
      branch, worktree, status, attempts, summary, activity, pr_status, agent_session_id, activity_at, finished_at,
      started_at, first_signal_at, shared, session_mode, provider_conversation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
  const insertMessage = db.prepare(`INSERT INTO outbox (run_id, node_id, from_session, message, created_at, mode)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const selectUndelivered = db.prepare(`SELECT id, message, mode FROM outbox
    WHERE run_id = ? AND node_id = ? AND delivered_at IS NULL
      AND id NOT IN (SELECT message_id FROM context_transfers WHERE attached = 0) ORDER BY id`);
  const updateDelivered = db.prepare("UPDATE outbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
  const updateSignal = db.prepare(`UPDATE nodes SET activity = COALESCE(?, activity),
    activity_at = CASE WHEN ? IS NULL THEN activity_at ELSE ? END,
    agent_session_id = COALESCE(?, agent_session_id),
    first_signal_at = COALESCE(first_signal_at, ?)
    WHERE run_id = ? AND id = ?`);
  const insertConversation = db.prepare(`INSERT INTO conversations (run_id, node_id, agent, conversation_id, seen_at)
    SELECT run_id, id, agent, ?, ? FROM nodes WHERE run_id = ? AND id = ?
    ON CONFLICT DO NOTHING`);
  const updateLaunched = db.prepare(`UPDATE nodes SET activity = ?, activity_at = ?, first_signal_at = NULL,
    started_at = COALESCE(started_at, ?) WHERE run_id = ? AND id = ?`);
  const selectConversations = db.prepare(`SELECT node_id, agent, conversation_id FROM conversations
    WHERE run_id = ? ORDER BY seen_at, node_id`);
  const updateStale = db.prepare("UPDATE nodes SET activity = 'exited' WHERE activity IS NOT NULL AND activity <> 'exited'");

  function forkRecord(runId: string): ForkRecord | undefined {
    const row = db.prepare("SELECT data_json FROM thread_forks WHERE run_id = ?").get(runId) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as ForkRecord : undefined;
  }
  function check(run: Run, fork?: ForkRecord): void {
    assertId("run", run.id);
    assertProjectId(run.project);
    assertId("node", run.node.id);
    // Later steps run git on this branch, so it must be the node's own.
    const owner = (fork ?? forkRecord(run.id))?.rootRun;
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
  const selectStale = db.prepare("SELECT run_id, id, activity FROM nodes WHERE activity IS NOT NULL AND activity <> 'exited'");
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
      const row=db.prepare("SELECT archived_at AS archivedAt,group_name AS 'group' FROM run_organization WHERE run_id=?").get(runId) as {archivedAt:string|null;group:string}|undefined;
      return row??{archivedAt:null,group:""};
    },
    organizeRun(runId,patch) {
      if(!selectRun.get(runId))throw new RunStoreError("unknown run");
      if(patch.name!==undefined){db.prepare("UPDATE runs SET name=? WHERE id=?").run(patch.name,runId);db.prepare("UPDATE nodes SET title=? WHERE run_id=? AND id='agent'").run(patch.name,runId);}
      db.prepare("INSERT OR IGNORE INTO run_organization(run_id) VALUES (?)").run(runId);
      if(patch.archived!==undefined)db.prepare("UPDATE run_organization SET archived_at=? WHERE run_id=?").run(patch.archived?new Date().toISOString():null,runId);
      if(patch.group!==undefined)db.prepare("UPDATE run_organization SET group_name=? WHERE run_id=?").run(patch.group,runId);
      logEvent(runId,NODE_ID,"thread.organized",patch);
    },
    saveRun(run, fork) {
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
          n.summary ?? null, n.activity ?? null, n.prStatus ?? null, n.agentSessionId ?? null,
          n.activityAt ?? null, n.finishedAt ?? null, n.startedAt ?? null, n.firstSignalAt ?? null,
          "[]", n.sessionMode ?? "terminal", n.providerConversationId ?? "",
        );
        if (fork) {
          db.prepare("INSERT INTO thread_forks (run_id, source_run, root_run, data_json) VALUES (?, ?, ?, ?)").run(run.id, fork.sourceRun, fork.rootRun, JSON.stringify(fork));
          logEvent(run.id, n.id, "conversation.forked", { source: fork.sourceRun, position: fork.position });
        }
        // Creation is recorded once, followed only by real state changes.
        if (before === undefined) logEvent(run.id, n.id, "run.created", { status: n.status, agent: n.agent });
        else if (before !== n.status) logEvent(run.id, n.id, "node.updated", { status: n.status });
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
        ...(n.agent_session_id !== null ? { agentSessionId: n.agent_session_id } : {}),
        ...(n.pr_status !== null ? { prStatus: n.pr_status as Node["prStatus"] } : {}),
        ...(n.activity_at !== null ? { activityAt: n.activity_at } : {}),
        ...(n.finished_at !== null ? { finishedAt: n.finished_at } : {}),
        ...(n.started_at !== null ? { startedAt: n.started_at } : {}),
        ...(n.first_signal_at !== null ? { firstSignalAt: n.first_signal_at } : {}),
        ...(n.session_mode === "chat" ? { sessionMode: "chat" as const } : {}),
        ...(n.provider_conversation_id ? { providerConversationId: n.provider_conversation_id } : {}),
      }));
      if (!nodes[0]) throw new RunStoreError(`run ${runId} has no session`);
      return {
        id: r.id, project: r.project, repo: r.repo, base: r.base, task: r.task,
        createdAt: r.created_at, role: r.role as Role, name: r.name,
        ...(r.orchestrator !== null ? { orchestrator: r.orchestrator } : {}),
        ...(r.model !== null ? { model: r.model } : {}),
        ...(r.issue !== null ? { issue: Number(r.issue) } : {}),
        ...(r.spec !== null ? { spec: JSON.parse(r.spec) as TaskSpec } : {}),
        ...(forkRecord(runId) ? { sharedWorkspace: forkRecord(runId)!.rootRun } : {}),
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
      const before = activityBefore(runId, nodeId);
      const now = state === null ? null : new Date().toISOString();
      const found = updateActivity.run(state, now, now, agentSessionId ?? null, runId, nodeId).changes > 0;
      if (found && state !== null && state !== before) logEvent(runId, nodeId, "activity", { from: before ?? null, to: state });
      return found;
    },

    recordSignal(runId, nodeId, state, agentSessionId) {
      const before = activityBefore(runId, nodeId);
      const now = new Date().toISOString();
      const at = state === null ? null : now;
      const found = updateSignal.run(state, at, at, agentSessionId ?? null, now, runId, nodeId).changes > 0;
      if (found && agentSessionId) insertConversation.run(agentSessionId, now, runId, nodeId);
      if (found && state !== null && state !== before) logEvent(runId, nodeId, "activity", { from: before ?? null, to: state });
      return found;
    },

    markLaunched(runId, nodeId, active = false) {
      const now = new Date().toISOString();
      updateLaunched.run(active ? "active" : "idle", now, now, runId, nodeId);
      logEvent(runId, nodeId, "launched");
    },

    conversations(runId) {
      return (selectConversations.all(runId) as { node_id: string; agent: string; conversation_id: string }[])
        .map((r) => ({ nodeId: r.node_id, agent: r.agent, id: r.conversation_id }));
    },

    createReport(runId, nodeId, kind, message) {
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

    markDelivered(id) {
      if (updateDelivered.run(new Date().toISOString(), id).changes === 0) return;
      const row = db.prepare("SELECT run_id, node_id FROM outbox WHERE id = ?").get(id) as { run_id: string; node_id: string } | undefined;
      if (row) logEvent(row.run_id, row.node_id, "message.delivered", { id });
    },

    exitStaleSessions() {
      // Record each session left behind by a stopped daemon as exited.
      const stale = selectStale.all() as { run_id: string; id: string; activity: string }[];
      for (const s of stale) logEvent(s.run_id, s.id, "session.exited", { from: s.activity, reason: "daemon restarted" });
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
      if (diff.length) logEvent(runId, nodeId, "node.updated", Object.fromEntries(diff.map((k) => [k, fields[k]])));
    },

    saveAutomation(a) {
      db.prepare(`INSERT INTO automations (id, project, repo, name, prompt, role, agent, cron, zone, enabled, next_run_at, last_run_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET prompt = excluded.prompt, role = excluded.role, agent = excluded.agent, cron = excluded.cron,
          zone = excluded.zone, enabled = excluded.enabled, next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at`)
        .run(a.id, a.project, a.repo, a.name, a.prompt, a.role, a.agent ?? null, a.cron, a.zone, a.enabled ? 1 : 0, a.nextRunAt, a.lastRunAt ?? null, a.createdAt);
    },

    listAutomations(project) {
      type Row = { id: string; project: string; repo: string; name: string; prompt: string; role: Role; agent: string | null; cron: string;
        zone: string; enabled: number; next_run_at: string; last_run_at: string | null; created_at: string };
      const rows = (project === undefined
        ? db.prepare("SELECT * FROM automations ORDER BY project, name").all()
        : db.prepare("SELECT * FROM automations WHERE project = ? ORDER BY name").all(project)) as Row[];
      return rows.map((r) => ({
        id: r.id, project: r.project, repo: r.repo, name: r.name, prompt: r.prompt, role: r.role, cron: r.cron, zone: r.zone,
        enabled: r.enabled === 1, nextRunAt: r.next_run_at, createdAt: r.created_at,
        ...(r.agent !== null ? { agent: r.agent } : {}), ...(r.last_run_at !== null ? { lastRunAt: r.last_run_at } : {}),
      }));
    },

    deleteAutomation(id) {
      return db.prepare("DELETE FROM automations WHERE id = ?").run(id).changes > 0;
    },

    recordAutomationRun(r) {
      db.prepare("INSERT INTO automation_runs (automation_id, scheduled_for, run_id, error, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(r.automationId, r.scheduledFor, r.runId ?? null, r.error ?? null, r.createdAt);
    },

    automationRuns(automationId) {
      type Row = { id: number; automation_id: string; scheduled_for: string; run_id: string | null; error: string | null; created_at: string };
      return (db.prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id").all(automationId) as Row[]).map((r) => ({
        id: Number(r.id), automationId: r.automation_id, scheduledFor: r.scheduled_for, createdAt: r.created_at,
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
      db.prepare(`DELETE FROM chat_conversations WHERE run_id IN (
        SELECT r.id FROM runs r WHERE r.project = ?
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id AND (n.finished_at IS NULL OR n.finished_at >= ?)))`).run(project, before);
      db.prepare(`DELETE FROM events WHERE run_id IN (
        SELECT r.id FROM runs r WHERE r.project = ?
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id AND (n.finished_at IS NULL OR n.finished_at >= ?)))`).run(project, before);
      return Number(db.prepare(`DELETE FROM timeline WHERE run_id IN (
        SELECT r.id FROM runs r WHERE r.project = ?
          AND EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.run_id = r.id AND (n.finished_at IS NULL OR n.finished_at >= ?)))`)
        .run(project, before).changes);
    },

    activeBranch(runId) {return branches(runId).find(b=>b.active);},
    branches,
    changeBranch(runId, prefix, history, restore) {
      const node = db.prepare("SELECT provider_conversation_id AS provider, agent FROM nodes WHERE run_id=? AND id='agent'").get(runId) as {provider:string;agent:string};
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
        db.prepare("UPDATE chat_conversations SET session=? WHERE run_id=? AND session='agent'").run('branch-'+current.id,runId);
        const id = target?.id ?? randomBytes(8).toString("hex");
        if (target) {
          if (target.agent !== node.agent) throw new RunStoreError("switch to the branch's provider before restoring it");
          db.prepare("UPDATE conversation_branches SET active=1 WHERE id=?").run(id);
          db.prepare("UPDATE chat_conversations SET session='agent' WHERE run_id=? AND session=?").run(runId,'branch-'+id);
        } else db.prepare("INSERT INTO conversation_branches(id,run_id,parent,items,snapshot,provider,agent,active) VALUES (?,?,?,?,?,?,?,1)").run(id,runId,current.id,JSON.stringify(prefix),JSON.stringify(prefix),'',node.agent);
        db.prepare("UPDATE nodes SET provider_conversation_id=?,status='running',finished_at=NULL,activity='idle' WHERE run_id=? AND id='agent'").run(target?.provider ?? '',runId);
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
    detachFork(runId) {
      const fork = forkRecord(runId);
      if (!fork) return;
      if (fork.detached) return;
      fork.detached = true;
      db.prepare("UPDATE nodes SET status = CASE WHEN status IN ('pending', 'running') THEN 'escalated' ELSE status END, finished_at = coalesce(finished_at, ?), activity = 'exited' WHERE run_id = ?")
        .run(new Date().toISOString(), runId);
      db.prepare("UPDATE thread_forks SET data_json = ? WHERE run_id = ?").run(JSON.stringify(fork), runId);
      logEvent(runId, NODE_ID, "conversation.detached");
    },
    workspaceForks(owner) {
      return (db.prepare("SELECT run_id FROM thread_forks WHERE root_run = ? AND coalesce(json_extract(data_json, '$.detached'), 0) = 0").all(owner) as { run_id: string }[]).map((r) => r.run_id);
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
        logEvent(source, NODE_ID, "context.merge_back", { id, target, through });
        logEvent(target, NODE_ID, "context.received", { id, source, through });
        db.exec("RELEASE store_write");
        return { id, duplicate: false };
      } catch (e) { db.exec("ROLLBACK TO store_write; RELEASE store_write"); throw e; }
    },
    waitTurn(runId, turn) {
      const row = db.prepare(`SELECT t.provider_turn_id AS id, t.state FROM chat_turns t
        JOIN chat_conversations c ON c.id = t.conversation_id
        WHERE c.run_id = ? AND c.session = 'agent' ${turn ? 'AND t.provider_turn_id = ?' : ''}
        ORDER BY t.requested_at DESC, t.rowid DESC LIMIT 1`).get(runId, ...(turn ? [turn] : [])) as { id: string; state: string } | undefined;
      if (turn && !row) throw new RunStoreError(`unknown turn ${turn}`);
      return row;
    },

    searchRuns(query, o) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const limit = Math.min(50, Math.max(1, o.limit));
      const metadataLimit = limit > 1 ? limit - Math.max(1, Math.floor(limit / 5)) : limit;
      const indexed = Array.from(q).length >= 3 && !q.includes('\0');
      const phrase = '"' + q.replace(/"/g, '""') + '"';
      const messageFilter = indexed ? "AND m.rowid IN (SELECT rowid FROM chat_search WHERE chat_search MATCH ? ORDER BY rowid DESC LIMIT 10000)" : "AND m.rowid >= (SELECT coalesce(max(rowid),0) - 20000 FROM chat_messages)";
      const timelineFilter = indexed ? "AND t.id IN (SELECT rowid FROM timeline_search WHERE timeline_search MATCH ? ORDER BY rowid DESC LIMIT 10000)" : "AND t.id >= (SELECT coalesce(max(id),0) - 20000 FROM timeline)";
      const project = o.project ? 'AND r.project = ?' : '';
      const args = o.project ? [o.project] : [];
      type Hit = { runId: string; project: string; title: string; source: string; snippet: string; position?: number };
      const hits = db.prepare(`SELECT r.id AS runId, r.project, r.name AS title, 'metadata' AS source,
        r.name || ' ' || r.task || ' branch: ' || n.branch || ' project: ' || r.project || coalesce(' PR: #' || p.number || ' ' || p.url, '') AS snippet FROM runs r JOIN nodes n ON n.run_id = r.id
        LEFT JOIN pull_requests p ON p.run_id = r.id
        WHERE instr(lower(r.name || ' ' || r.task || ' ' || n.branch || ' ' || r.project || ' ' || coalesce('#' || p.number || ' ' || p.url, '')), ?) > 0
        ${project} ORDER BY r.created_at DESC LIMIT ?`).all(q, ...args, metadataLimit) as Hit[];
      if (hits.length < limit) {
        const messages = db.prepare(`SELECT r.id AS runId, r.project, r.name AS title,
          m.role AS source, m.text AS snippet, m.sequence AS position, m.created_at AS at
          FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
          JOIN runs r ON r.id = c.run_id
          WHERE c.session = 'agent' AND m.streaming = 0 AND instr(lower(m.text), ?) > 0 ${messageFilter} ${project}
          UNION ALL
          SELECT r.id, r.project, r.name, CASE WHEN t.kind = 'assistant' THEN 'assistant' ELSE 'user' END,
          t.text, t.id, t.at FROM timeline t JOIN runs r ON r.id = t.run_id
          JOIN nodes n ON n.run_id = r.id
          WHERE n.session_mode <> 'chat' AND t.session = 'agent' AND t.kind IN ('prompt','message','assistant')
          AND instr(lower(t.text), ?) > 0 ${timelineFilter} ${project}
          ORDER BY at DESC LIMIT ?`).all(q, ...(indexed ? [phrase] : []), ...args, q, ...(indexed ? [phrase] : []), ...args, limit - hits.length) as Hit[];
        hits.push(...messages);
      }
      return hits.map((h) => {
        const text = redact(h.snippet);
        const at = Math.max(0, text.toLowerCase().indexOf(q) - 80);
        return { runId: h.runId, project: h.project, title: redact(h.title), source: h.source,
          snippet: `${at ? '…' : ''}${text.slice(at, at + 320)}${text.length > at + 320 ? '…' : ''}`,
          ...(h.position === undefined ? {} : { position: h.position }) };
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
        let conv = db.prepare("SELECT id FROM chat_conversations WHERE run_id = ? AND session = ?").get(runId, session) as { id: string } | undefined;
        if (!conv) {
          conv = { id: randomBytes(8).toString("hex") };
          db.prepare("INSERT INTO chat_conversations (id, scope, project, run_id, session, created_at, updated_at) VALUES (?, 'session', ?, ?, ?, ?, ?)")
            .run(conv.id, run.project, runId, session, now, now);
        }
        const c = conv.id;
        const inheritedMax = prefixFor(runId).at(-1)?.position ?? 0;
        db.prepare("UPDATE chat_conversations SET latest_sequence = max(latest_sequence, ?) WHERE id = ?").run(inheritedMax, c);
        const nextSeq = () => Number((db.prepare("UPDATE chat_conversations SET latest_sequence = latest_sequence + 1, updated_at = ? WHERE id = ? RETURNING latest_sequence")
          .get(now, c) as { latest_sequence: number }).latest_sequence);
        const turnRow = (providerTurnId?: string) => providerTurnId
          ? (db.prepare("SELECT id FROM chat_turns WHERE conversation_id = ? AND provider_turn_id = ?").get(c, providerTurnId) as { id: string } | undefined)?.id ?? null
          : null;
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
              db.prepare("UPDATE nodes SET provider_conversation_id = ? WHERE run_id = ? AND id = ?").run(e.id, runId, NODE_ID);
              logEvent(runId, NODE_ID, "chat.conversation", { id: e.id });
              // Its agent keeps the conversation on disk too, so usage is counted from it as for a
              // terminal session: complete even when a turn is cut short.
              insertConversation.run(e.id, now, runId, NODE_ID);
            }
          } else if (e.type === "turn") {
            const id = turnRow(e.turnId);
            if (e.state === "running") {
              const agent = (db.prepare("SELECT agent FROM nodes WHERE run_id = ? AND id = ?").get(runId, NODE_ID) as { agent: string } | undefined)?.agent ?? "";
              if (!id) db.prepare("INSERT INTO chat_turns (id, conversation_id, provider_turn_id, state, requested_at, started_at, agent, provider_conversation_id) VALUES (?, ?, ?, 'running', ?, ?, ?, (SELECT provider_conversation_id FROM nodes WHERE run_id = ? AND id = 'agent'))")
                .run(randomBytes(8).toString("hex"), c, e.turnId, now, now, agent, runId);
              out.activity = "active";
            } else {
              if (id) db.prepare("UPDATE chat_turns SET state = ?, error_message = ?, completed_at = ? WHERE id = ?").run(e.state, e.error ?? "", now, id);
              out.activity = "idle";
            }
          } else if (e.type === "message") {
            let text = redact(e.text);
            if (e.role === "user" && !e.itemId.startsWith("rivet-") && !db.prepare("SELECT 1 FROM chat_messages WHERE conversation_id=? AND provider_item_id=?").get(c,e.itemId)) {
              const hostPrompts = db.prepare("SELECT id,text FROM chat_messages WHERE conversation_id=? AND role='user' AND provider_item_id LIKE 'rivet-%' ORDER BY sequence").all(c) as {id:string;text:string}[];
              const host = hostPrompts.find(p=>text === p.text || text.endsWith("\n\n"+p.text));
              if (host) {
                db.prepare("UPDATE chat_messages SET provider_item_id=?,turn_id=? WHERE id=?").run(e.itemId,turnRow(e.turnId),host.id);
                text = host.text;
              }
            }
            const found = db.prepare("SELECT id FROM chat_messages WHERE conversation_id = ? AND provider_item_id = ?").get(c, e.itemId) as { id: string } | undefined;
            const streaming = e.streaming ? 1 : 0;
            if (found) db.prepare("UPDATE chat_messages SET text = ?, streaming = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(text, streaming, now, found.id);
            else db.prepare(`INSERT INTO chat_messages (id, conversation_id, turn_id, sequence, role, origin, text, streaming, provider_item_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomBytes(8).toString("hex"), c, turnRow(e.turnId), nextSeq(), e.role, e.role === "user" ? "daemon" : "provider", text, streaming, e.itemId, now, now);
          } else if(e.type==="history") {
            const existing=db.prepare("SELECT id,role,text,streaming,provider_item_id AS providerId FROM chat_messages WHERE conversation_id=? ORDER BY sequence").all(c) as {id:string;role:string;text:string;streaming:number;providerId:string}[];
            const used=new Set<string>();
            for(const [index,item] of e.items.entries()){
              const whole=redact(item.text);
              const providerId="acp-history-"+createHash("sha256").update(JSON.stringify([e.providerId,index,item.role,whole])).digest("hex");
              const exact=existing.find(row=>!used.has(row.id)&&row.providerId===providerId);
              const matched=exact??existing.find(row=>!used.has(row.id)&&row.role===item.role&&(row.text===whole || item.role==="user"&&whole.endsWith("\n\n"+row.text) || item.role==="assistant"&&row.streaming===1&&row.text.length>0&&whole.startsWith(row.text)));
              if(matched){
                used.add(matched.id);
                if(matched.streaming)db.prepare("UPDATE chat_messages SET text=?,streaming=0,revision=revision+1,updated_at=? WHERE id=?").run(whole,now,matched.id);
              }else{
                const id=randomBytes(8).toString("hex");
                db.prepare("INSERT INTO chat_messages(id,conversation_id,sequence,role,origin,text,streaming,provider_item_id,created_at,updated_at) VALUES (?,?,?,?,'provider',?,0,?,?,?)").run(id,c,nextSeq(),item.role,whole,providerId,now,now);
                existing.push({id,role:item.role,text:whole,streaming:0,providerId});used.add(id);
              }
            }
            out.activity="idle";
            logEvent(runId,session,"chat.history-reconciled",{items:e.items.length,provider:e.providerId,positionPolicy:"append missing entries; preserve existing positions"});
          } else if (e.type === "usage") {
            // add: one turn's use on top of the totals; set: the agent's own totals. Context
            // figures are always the latest.
            const op = (col: string, v: number | undefined) => v === undefined ? "" : e.mode === "add" ? `${col} = COALESCE(${col}, 0) + ${Math.round(v)}` : `${col} = ${Math.round(v)}`;
            const sets = [op("usage_input_tokens", e.input), op("usage_output_tokens", e.output), op("usage_cached_tokens", e.cached), op("usage_total_tokens", e.total),
              e.contextUsed !== undefined ? `context_used = ${Math.round(e.contextUsed)}` : "", e.contextWindow !== undefined ? `context_window = ${Math.round(e.contextWindow)}` : ""].filter(Boolean);
            if (sets.length) db.prepare(`UPDATE chat_conversations SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(now, c);
          } else {
            const key = e.requestId ? "request_id" : "provider_item_id";
            const keyValue = e.requestId ?? e.itemId ?? "";
            const detail = e.output !== undefined || e.tool !== undefined ? JSON.stringify({ ...(e.tool ? { tool: e.tool } : {}), ...(e.output !== undefined ? { output: redact(e.output) } : {}) }) : "";
            const found = keyValue ? db.prepare(`SELECT id, summary FROM chat_activities WHERE conversation_id = ? AND ${key} = ?`).get(c, keyValue) as { id: string; summary: string } | undefined : undefined;
            const summary = redact(e.summary);
            if (found) db.prepare("UPDATE chat_activities SET status = ?, summary = ?, detail_json = CASE WHEN ? = '' THEN detail_json ELSE ? END, revision = revision + 1, updated_at = ? WHERE id = ?")
              .run(e.status, e.kind === "approval" && e.status === "resolved" ? `${found.summary} (${summary})` : summary || found.summary, detail, detail, now, found.id);
            else db.prepare(`INSERT INTO chat_activities (id, conversation_id, turn_id, sequence, kind, status, summary, detail_json, request_id, provider_item_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomBytes(8).toString("hex"), c, turnRow(e.turnId), nextSeq(), e.kind, e.status, summary, detail,
                e.requestId ?? "", e.requestId ? "" : e.itemId ?? "", now, now);
            if (e.kind === "approval" && e.status === "pending") {
              out.activity = "blocked";
              out.question = { tool: e.tool ?? "tool", detail: summary.replace(/^[^:]*: /, ""), requestId: e.requestId ?? "" };
            } else if (e.kind === "approval" && e.status === "resolved") {
              out.question = null;
              out.activity = "active";
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

    chatUsage(runId, session = NODE_ID) {
      const r = db.prepare(`SELECT usage_input_tokens AS input, usage_output_tokens AS output, usage_cached_tokens AS cached, usage_total_tokens AS total,
        context_used AS used, context_window AS window FROM chat_conversations WHERE run_id = ? AND session = ?`).get(runId, session) as
        { input: number | null; output: number | null; cached: number | null; total: number | null; used: number | null; window: number | null } | undefined;
      if (!r || (r.total === null && r.used === null)) return null;
      return { input: Number(r.input ?? 0), output: Number(r.output ?? 0), cached: Number(r.cached ?? 0), total: Number(r.total ?? 0),
        ...(r.used !== null ? { contextUsed: Number(r.used) } : {}), ...(r.window !== null ? { contextWindow: Number(r.window) } : {}) };
    },

    recordProviderLines(runId, session, lines) {
      const conv = db.prepare("SELECT id FROM chat_conversations WHERE run_id = ? AND session = ?").get(runId, session) as { id: string } | undefined;
      if (!conv) return 0;
      const insert = db.prepare("INSERT OR IGNORE INTO chat_provider_events (conversation_id, provider_event_id, method, payload_json, received_at) VALUES (?, ?, ?, ?, ?)");
      const now = new Date().toISOString();
      let kept = 0;
      db.exec("SAVEPOINT store_write");
      try {
        for (const line of lines) {
          let m: { method?: unknown; id?: unknown; result?: unknown; error?: unknown };
          try { m = JSON.parse(line); } catch { continue; }
          // A reply to Rivet's own call has no method: it is named after what it answers.
          const method = typeof m.method === "string" ? m.method : m.error !== undefined ? "error" : "result";
          kept += Number(insert.run(conv.id, "", method, redact(line), now).changes);
        }
        db.exec("RELEASE store_write");
      } catch (e) {
        db.exec("ROLLBACK TO store_write; RELEASE store_write");
        throw e;
      }
      return kept;
    },

    providerLines(runId, o) {
      const conv = db.prepare("SELECT id FROM chat_conversations WHERE run_id = ? AND session = ?").get(runId, o.session ?? NODE_ID) as { id: string } | undefined;
      if (!conv) return [];
      type Row = { id: number; method: string; payload_json: string; received_at: string };
      return (db.prepare("SELECT id, method, payload_json, received_at FROM chat_provider_events WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?")
        .all(conv.id, o.after ?? 0, o.limit) as Row[]).map((r) => ({ position: Number(r.id), method: r.method, payload: r.payload_json, at: r.received_at }));
    },

    readChat(runId, o) {
      const conv = db.prepare("SELECT id FROM chat_conversations WHERE run_id = ? AND session = ?").get(runId, o.session ?? NODE_ID) as { id: string } | undefined;
      const inherited = o.session && o.session !== NODE_ID ? [] : prefixFor(runId);
      if (!conv) {
        const shown = inherited.filter((i) => !o.kinds || o.kinds.includes(i.kind));
        return { total: shown.length, items: shown.filter((i) => i.position > (o.after ?? 0)).slice(0, o.limit) };
      }
      type Row = { sequence: number; source: string; role: string | null; kind: string | null; status: string | null; text: string; detail: string; at: string; streaming: number; agent: string | null; turn_id: string | null; provider: string | null };
      const rows = db.prepare(`
        SELECT sequence, 'message' AS source, role, NULL AS kind, NULL AS status, text, '' AS detail, created_at AS at, streaming,
          (SELECT agent FROM chat_turns t WHERE t.id = turn_id) AS agent, (SELECT provider_turn_id FROM chat_turns t WHERE t.id = turn_id) AS turn_id, (SELECT provider_conversation_id FROM chat_turns t WHERE t.id = turn_id) AS provider FROM chat_messages WHERE conversation_id = ?
        UNION ALL
        SELECT sequence, 'activity', NULL, kind, status, summary, detail_json, created_at, 0, NULL, NULL, NULL FROM chat_activities WHERE conversation_id = ?
        ORDER BY sequence`).all(conv.id, conv.id) as Row[];
      let firstUser = !inherited.some((i) => i.kind === "prompt" || i.kind === "message");
      const all: TimelineItem[] = [...inherited];
      for (const r of rows) {
        const base = { position: Number(r.sequence), session: o.session ?? NODE_ID, at: r.at };
        if (r.source === "message") {
          const kind: TimelineKind = r.role === "assistant" ? "assistant" : firstUser ? "prompt" : "message";
          if (r.role === "user") firstUser = false;
          all.push({ ...base, kind, text: r.text, ...(r.streaming ? { streaming: true } : {}), ...(r.agent ? { agent: r.agent } : {}), ...(r.turn_id ? { turnId: r.turn_id } : {}), ...(r.provider ? { providerConversationId: r.provider } : {}) });
          continue;
        }
        const detail = r.detail ? JSON.parse(r.detail) as { tool?: string; output?: string } : {};
        if (r.kind === "command" || r.kind === "file_change") {
          const failed = r.status === "failed" ? " (failed)" : "";
          all.push({ ...base, kind: "tool", tool: detail.tool ?? (r.kind === "command" ? "shell" : "edit"), text: `${r.text}${failed}${detail.output ? `\n${detail.output}` : ""}` });
        } else if (r.kind === "approval") all.push({ ...base, kind: "event", text: `asked to use ${r.text}${r.status === "pending" ? " (waiting for an answer)" : ""}` });
        else if (r.kind !== "usage") all.push({ ...base, kind: "event", text: `${r.kind}: ${r.text}` });
      }
      const kinds = new Set(o.kinds ?? TIMELINE_KINDS);
      const shown = all.filter((i) => kinds.has(i.kind));
      const after = o.after ?? 0;
      return { total: shown.length, items: shown.filter((i) => i.position > after).slice(0, o.limit) };
    },

    listProjects() {
      return (db.prepare("SELECT DISTINCT project FROM runs ORDER BY project").all() as { project: string }[]).map((r) => r.project);
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
      logEvent(runId, "review", "review.started", { sha, trigger });
      return Number(db.prepare("INSERT INTO reviews (run_id, sha, trigger, status, created_at) VALUES (?, ?, ?, 'running', ?)")
        .run(runId, sha, trigger, new Date().toISOString()).lastInsertRowid);
    },

    endReview(id, f) {
      const ended = db.prepare("UPDATE reviews SET status = ?, verdict = ?, body = ?, github_review_id = ? WHERE id = ? AND status = 'running'")
        .run(f.status, f.verdict ?? null, f.body ?? null, f.githubReviewId ?? null, id).changes;
      const row = ended ? db.prepare("SELECT run_id FROM reviews WHERE id = ?").get(id) as { run_id: string } | undefined : undefined;
      if (row) logEvent(row.run_id, "review", "review.ended", { status: f.status, verdict: f.verdict ?? null });
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
      logEvent(runId, null, "pr", { number: pr.number, handled: pr.handled ?? null });
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
  try { return journalStore(db,data,store); } catch(error) {db.close();throw error;}
}
