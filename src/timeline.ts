// Each session's timeline: what it was told, what it did and what it said, kept in Rivet's
// own store. It is built only from documented interfaces: what Rivet itself sends, the
// agents' hooks, and Codex's --json event stream; never from the agents' own files.

export const TIMELINE_KINDS = ["prompt", "message", "assistant", "tool", "result", "event"] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
export type TimelineEntry = { kind: TimelineKind; text: string; tool?: string };

// The kinds the "messages" view shows: what the agent was told and what it said.
export const MESSAGE_KINDS: TimelineKind[] = ["prompt", "message", "assistant"];

// Stored at most; reads cut further. Tool results are cut harder: they are long and noisy.
export const ENTRY_LIMIT = 100_000;
const RESULT_LIMIT = 4_000;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[cut at ${n} characters]` : s);
const text = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

// A tool call in one line: its name and what it acts on.
export function describeTool(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const main = [i.command, i.file_path, i.path, i.pattern, i.url, i.skill, i.description].find((v) => typeof v === "string" && v.trim());
  return (main as string | undefined)?.trim() ?? cut(JSON.stringify(input ?? {}), 300);
}

// Claude Code hooks (checked live): UserPromptSubmit has prompt, PreToolUse tool_name and
// tool_input, PostToolUse also tool_response, Stop last_assistant_message.
function fromClaudeHook(event: string, p: Record<string, unknown>): TimelineEntry[] {
  switch (event) {
    case "user-prompt-submit":
      return typeof p.prompt === "string" && p.prompt.trim() ? [{ kind: "prompt", text: p.prompt }] : [];
    case "pre-tool-use":
      return typeof p.tool_name === "string" ? [{ kind: "tool", tool: p.tool_name, text: describeTool(p.tool_input) }] : [];
    case "post-tool-use":
    case "post-tool-use-failure": {
      if (typeof p.tool_name !== "string") return [];
      const out = text(p.tool_response ?? p.error).trim();
      return out ? [{ kind: "result", tool: p.tool_name, text: cut(out, RESULT_LIMIT) }] : [];
    }
    case "stop":
    case "subagent-stop":
      return typeof p.last_assistant_message === "string" && p.last_assistant_message.trim()
        ? [{ kind: "assistant", text: p.last_assistant_message }] : [];
    default:
      return [];
  }
}

// Codex hooks: their fields are not checked live, so only clearly named ones are taken.
function fromCodexHook(event: string, p: Record<string, unknown>): TimelineEntry[] {
  if (event === "user-prompt-submit" && typeof p.prompt === "string" && p.prompt.trim()) return [{ kind: "prompt", text: p.prompt }];
  const last = p.last_assistant_message ?? p["last-assistant-message"];
  if (event === "stop" && typeof last === "string" && last.trim()) return [{ kind: "assistant", text: last }];
  return [];
}

export function fromHook(agent: string, event: string, payload: Record<string, unknown>): TimelineEntry[] {
  const entries = agent === "claude-code" ? fromClaudeHook(event, payload) : agent === "codex" ? fromCodexHook(event, payload) : [];
  return entries.map((e) => ({ ...e, text: cut(e.text, ENTRY_LIMIT) }));
}

// One line of `codex exec --json` (checked live): item.completed carries agent_message
// text, command_execution command and output, file_change paths.
export function fromCodexJson(line: string): TimelineEntry[] | null {
  let e: { type?: string; item?: Record<string, unknown> };
  try { e = JSON.parse(line); } catch { return null; }
  if (!e || typeof e !== "object" || typeof e.type !== "string") return null;
  const item = e.item ?? {};
  if (e.type === "item.started" && item.type === "command_execution") {
    return [{ kind: "tool", tool: "shell", text: text(item.command) }];
  }
  if (e.type !== "item.completed") return [];
  if (item.type === "agent_message" && typeof item.text === "string") return [{ kind: "assistant", text: cut(item.text, ENTRY_LIMIT) }];
  if (item.type === "command_execution") {
    const out = text(item.aggregated_output).trim();
    return out ? [{ kind: "result", tool: "shell", text: cut(out, RESULT_LIMIT) }] : [];
  }
  if (item.type === "file_change") {
    const changes = Array.isArray(item.changes) ? (item.changes as { path?: string; kind?: string }[]) : [];
    return [{ kind: "tool", tool: "edit", text: changes.map((c) => `${c.kind ?? "change"} ${c.path ?? ""}`.trim()).join(", ") || "files changed" }];
  }
  return [];
}

// What a headless Codex printed, as text a person (or a retry prompt) can read.
export function readableOutput(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const entries = fromCodexJson(line);
    if (entries === null) out.push(line);
    else for (const e of entries) out.push(e.kind === "tool" ? `$ ${e.text}` : e.text);
  }
  return out;
}
