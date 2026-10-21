import type { ActivityState } from "../model.js";

type Payload = Record<string, unknown>;

// Claude Code: what each hook event says about the agent. null = the event carries no
// activity signal (it may still carry the agent's own session id).
function claudeCode(event: string, payload: Payload): ActivityState | null {
  switch (event) {
    case "user-prompt-submit":
    case "pre-tool-use":
    case "post-tool-use":
    case "post-tool-use-failure":
      return "active";
    case "permission-request":
      return "blocked";
    case "stop":
      return "idle";
    case "notification":
      return ({
        idle_prompt: "idle",
        agent_completed: "idle",
        agent_needs_input: "waiting_input",
        permission_prompt: "blocked",
      } as Record<string, ActivityState>)[String(payload.notification_type)] ?? null;
    case "session-end":
      // Clearing or resuming ends one conversation but not the agent.
      return payload.reason === "clear" || payload.reason === "resume" ? null : "exited";
    default:
      return null;
  }
}

// Codex hooks: a prompt starts work, a permission prompt waits on the user, stop is idle.
function codex(event: string): ActivityState | null {
  return ({ "user-prompt-submit": "active", "permission-request": "waiting_input", stop: "idle" } as Record<string, ActivityState>)[event] ?? null;
}

const BY_AGENT: Record<string, (event: string, payload: Payload) => ActivityState | null> = {
  "claude-code": claudeCode,
  codex,
};

export function deriveActivity(agent: string, event: string, payload: Payload): ActivityState | null {
  return BY_AGENT[agent]?.(event, payload) ?? null;
}

// The agent's own conversation id, so the session can be resumed later.
export function agentSessionIdOf(payload: Payload): string | undefined {
  const id = payload.session_id ?? payload.sessionId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}
