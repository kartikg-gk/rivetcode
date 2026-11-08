// "fake" runs a scripted stand-in instead of a model, for end-to-end tests.
export const AGENTS = ["claude", "codex", "fake", "delta"] as const;
export const STATUSES = ["pending", "running", "done", "failed", "escalated"] as const;
// A worker does one task in its own worktree and opens its own pull request; an
// orchestrator only coordinates: it starts workers, messages them and reports.
export const ROLES = ["worker", "orchestrator"] as const;

// What an agent session is doing right now.
export const ACTIVITY_STATES = ["busy", "idle", "asking", "approval", "ended"] as const;
// Where a worker's pull request stands.
export const PR_STATUSES = [
  "open", "draft", "checks-failing", "changes-wanted", "awaiting-review", "approved", "ready", "merged", "closed",
  // Rivet stopped watching it for the person to decide (feedback could not be handed over).
  "needs-you",
] as const;

export type Agent = (typeof AGENTS)[number];
export type Status = (typeof STATUSES)[number];
export type Role = (typeof ROLES)[number];
export type ActivityState = (typeof ACTIVITY_STATES)[number];
export type PrStatus = (typeof PR_STATUSES)[number];

// The one agent session of a run.
export type Node = {
  id: string;
  title: string;
  prompt: string;
  agent: Agent;
  branch: string;
  worktree: string;
  status: Status;
  attempts: number;
  summary?: string;
  activity?: ActivityState;
  agentSessionId?: string;
  prStatus?: PrStatus;
  // When the agent last reported activity (ISO); the status view shows idle time from it.
  activityAt?: string;
  // When its work finished and was handed to the check.
  finishedAt?: string;
  // When its agent first started (retries keep it).
  startedAt?: string;
  // The first hook of the current launch; unset means the agent has not been heard from.
  firstSignalAt?: string;
  // How the session runs: in a terminal (the agent's own CLI) or as a chat (its protocol).
  sessionMode?: SessionMode;
  // A chat's conversation id at the agent, to resume it.
  providerConversationId?: string;
};

export const SESSION_MODES = ["terminal", "chat"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

// Every run has exactly one node, under this id; its session is "<run>-agent".
export const NODE_ID = "agent";

const TRANSITIONS: Partial<Record<Status, Status[]>> = {
  pending: ["running"],
  running: ["done", "failed", "escalated"],
  failed: ["running", "escalated"],
  escalated: ["running"],
  // Feedback on its pull request sends finished work back.
  done: ["running"],
};

// A validated status change; starting to run counts an attempt.
export function setStatus(node: Node, to: Status, summary?: string): Node {
  if (!(TRANSITIONS[node.status] ?? []).includes(to)) {
    throw new Error(`${node.id} cannot go from ${node.status} to ${to}`);
  }
  return {
    ...node,
    status: to,
    attempts: to === "running" ? node.attempts + 1 : node.attempts,
    ...(summary !== undefined ? { summary } : {}),
  };
}

// How long a launched agent may stay silent before Rivet stops calling it idle: its boot
// plus the gap to its first hook. Past it, silence looks the same as broken hooks.
export const NO_SIGNAL_GRACE_MS = 90_000;

// A live agent that should report through hooks, has not since this launch, and has
// been quiet past the grace period: working or stuck can not be told apart.
export function noSignal(node: Node, now: number, alive: boolean, signals: boolean): boolean {
  return alive && signals && !node.firstSignalAt && node.activity === "idle"
    && !!node.activityAt && now - Date.parse(node.activityAt) > NO_SIGNAL_GRACE_MS;
}
