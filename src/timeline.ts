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

// Secrets a command or file can print: removed before an entry is stored, as the timeline
// is kept and other agents read it. A named secret keeps its name.
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[secret removed]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[secret removed]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[secret removed]"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, "[secret removed]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[secret removed]"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, "[secret removed]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[secret removed]"],
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, "$1[secret removed]"],
  // The name must end in the secret word (input_tokens, tokenizer are not secrets), and a
  // number is a count, not a secret.
  [/(\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY)\b\s*[=:]\s*["']?)(?!\[secret removed\])(?!\d+\b)[^\s"'#]{6,}/gi, "$1[secret removed]"],
];

export function redact(s: string): string {
  return SECRETS.reduce((out, [pattern, to]) => out.replace(pattern, to), s);
}

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
  // Codex events are dotted (item.completed, turn.started); anything else is not one.
  if (!e.type.includes(".") && e.type !== "error") return null;
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

// One line of Claude's `--output-format stream-json` (checked live): assistant events carry
// text and tool_use parts, user events tool_result parts. toolNames maps a tool_use id to
// its tool, so a result is named after the call it answers.
export function fromClaudeStream(line: string, toolNames: Map<string, string> = new Map()): TimelineEntry[] | null {
  let e: { type?: string; message?: { content?: unknown } };
  try { e = JSON.parse(line); } catch { return null; }
  if (!e || typeof e !== "object" || typeof e.type !== "string") return null;
  if (e.type !== "assistant" && e.type !== "user") return [];
  const parts = Array.isArray(e.message?.content) ? (e.message!.content as Record<string, unknown>[]) : [];
  const out: TimelineEntry[] = [];
  for (const p of parts) {
    if (e.type === "assistant" && p.type === "text" && typeof p.text === "string" && p.text.trim()) {
      out.push({ kind: "assistant", text: cut(p.text, ENTRY_LIMIT) });
    } else if (e.type === "assistant" && p.type === "tool_use" && typeof p.name === "string") {
      if (typeof p.id === "string") toolNames.set(p.id, p.name);
      out.push({ kind: "tool", tool: p.name, text: describeTool(p.input) });
    } else if (e.type === "user" && p.type === "tool_result") {
      const content = Array.isArray(p.content)
        ? (p.content as { type?: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
        : text(p.content);
      const tool = typeof p.tool_use_id === "string" ? toolNames.get(p.tool_use_id) : undefined;
      if (content.trim()) out.push({ kind: "result", text: cut(content.trim(), RESULT_LIMIT), ...(tool ? { tool } : {}) });
    }
  }
  return out;
}

// A line of either agent's JSON stream, or null when it is not one.
export function fromStream(line: string, toolNames?: Map<string, string>): TimelineEntry[] | null {
  return fromCodexJson(line) ?? fromClaudeStream(line, toolNames);
}

// What a headless agent printed as JSON events, as text a person (or a retry prompt) can read.
export function readableOutput(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const entries = fromStream(line);
    if (entries === null) out.push(line);
    else for (const e of entries) out.push(e.kind === "tool" ? `$ ${e.text}` : e.text);
  }
  return out;
}
