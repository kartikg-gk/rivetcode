import { mcpLaunch } from "../mcp/launch.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describeTool } from "../timeline.js";
import { connect, type Rpc } from "./rpc.js";

// What a conversation reports, the same for every agent. Rivet keeps it in its
// conversation tables and derives the session's activity from it.
export type ActivityKind = "command" | "file_change" | "plan" | "reasoning" | "approval" | "usage" | "error" | "system";
export type ActivityStatus = "running" | "completed" | "failed" | "pending" | "resolved";
export type ChatEvent =
  | { type: "conversation"; id: string; forkStrategy?: "native" | "reconstructed" }
  | { type: "turn"; turnId: string; state: "running" | "completed" | "interrupted" | "failed"; error?: string }
  // streaming: the text so far of a reply still being written; the same item comes again,
  // longer, until a last time without it.
  | { type: "message"; itemId: string; role: "user" | "assistant"; text: string; turnId?: string; streaming?: boolean }
  // Tokens: "add" counts one turn's use, "set" replaces the totals with the agent's own.
  // contextUsed/contextWindow: how full the conversation's context is.
  | { type: "usage"; mode: "add" | "set"; input?: number; output?: number; cached?: number; total?: number; contextUsed?: number; contextWindow?: number }
  | { type: "activity"; itemId?: string; requestId?: string; kind: ActivityKind; status: ActivityStatus; summary: string; tool?: string; output?: string; turnId?: string };

// What a permission question asks: the tool, and its command or file.
export type Approval = { requestId: string; tool: string; detail: string; command?: string };
export type Choice = "yes" | "always" | "no";

export type ChatOptions = {
  binary: string;
  cwd: string;
  model?: string;
  permission: string;
  resume?: string;
  fork?: { providerId: string; turn?: string; agent: string; context: string };
  env: Record<string, string>;
  emit(e: ChatEvent): void;
  // Every line the agent wrote, as it came, for the record.
  raw?(line: string): void;
  // Answers a question on its own (e.g. a command the session is allowed), or leaves it to
  // be answered by rivet answer.
  decide(a: Approval): Choice | undefined;
};

export type ChatDriver = {
  start(): Promise<void>;
  // Runs one turn and resolves when it ends.
  prompt(text: string): Promise<void>;
  // Adds guidance to the turn in progress; false when there is none to join.
  steer(text: string): Promise<boolean>;
  cancel(): Promise<void>;
  answer(requestId: string, choice: Choice): boolean;
  readonly running: boolean;
  close(): void;
  exited: Promise<void>;
};

// An agent CLI on Windows may be a .cmd shim, which only a shell can run.
function launch(argv: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const [cmd, ...args] = argv;
  return spawn(cmd!, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], shell: /\.(cmd|bat)$/i.test(cmd!), windowsHide: true });
}

// Tests replace the agent with a script: RIVET_CHAT_COMMAND is its argv as JSON.
function override(env: Record<string, string>): string[] | null {
  const raw = env.RIVET_CHAT_COMMAND ?? process.env.RIVET_CHAT_COMMAND;
  return raw ? (JSON.parse(raw) as string[]) : null;
}

const RESULT_LIMIT = 4_000;
// A reply being written is reported at most this often.
const STREAM_EVERY_MS = 150;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// Reports a growing reply now and then, and whole at the end.
function streamer(emit: (e: ChatEvent) => void) {
  const last = new Map<string, number>();
  return {
    grow(itemId: string, textSoFar: string, turnId: string) {
      const now = Date.now();
      if (now - (last.get(itemId) ?? 0) < STREAM_EVERY_MS) return;
      last.set(itemId, now);
      emit({ type: "message", itemId, role: "assistant", text: textSoFar, turnId, streaming: true });
    },
    done(itemId: string, whole: string, turnId: string) {
      last.delete(itemId);
      if (whole.trim()) emit({ type: "message", itemId, role: "assistant", text: whole, turnId });
    },
  };
}
const text = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

// The ACP adapter for Claude Code ships with Rivet; Claude Code itself is the user's own
// install, so their login, subscription, settings and project instructions apply.
export function claudeAdapterPath(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
  const bin = (require(pkg) as { bin?: Record<string, string> }).bin?.["claude-agent-acp"] ?? "dist/index.js";
  const path = join(dirname(pkg), bin);
  if (!existsSync(path)) throw new Error(`Claude's chat adapter is missing: ${path}`);
  return path;
}

const CLAUDE_MODES: Record<string, string> = {
  default: "default", "accept-edits": "acceptEdits", auto: "auto", "bypass-permissions": "bypassPermissions", "read-only": "plan",
};

// Claude over the Agent Client Protocol.
export function claudeChat(o: ChatOptions): ChatDriver {
  const argv = override(o.env) ?? [process.execPath, claudeAdapterPath()];
  const child = launch(argv, o.cwd, { ...o.env, CLAUDE_CODE_EXECUTABLE: o.binary });
  let sessionId = "";
  let turn = 0;
  let activeTurn = "";
  // Assistant text arrives in pieces; each message is kept whole once it is complete.
  let message: { id: string; text: string } | null = null;
  const tools = new Map<string, { tool: string; summary: string }>();
  const questions = new Map<string, { id: number | string; options: { optionId: string; kind: string }[] }>();
  const stream = streamer(o.emit);
  const flush = () => {
    if (message) stream.done(message.id, message.text, activeTurn);
    message = null;
  };
  const rpc: Rpc = connect(child, {
    notify(method, params) {
      if (method !== "session/update") return;
      const u = (params.update ?? {}) as Record<string, unknown>;
      const kind = u.sessionUpdate;
      if (kind === "agent_message_chunk") {
        const id = typeof u.messageId === "string" ? u.messageId : `m${turn}`;
        const piece = text((u.content as { text?: unknown } | undefined)?.text);
        if (message && message.id !== id) flush();
        message = message ?? { id, text: "" };
        message.text += piece;
        stream.grow(message.id, message.text, activeTurn);
        return;
      }
      if (kind === "usage_update") {
        o.emit({ type: "usage", mode: "set", ...(num(u.used) !== undefined ? { contextUsed: num(u.used)! } : {}), ...(num(u.size) !== undefined ? { contextWindow: num(u.size)! } : {}) });
        return;
      }
      if (kind !== "tool_call" && kind !== "tool_call_update" && kind !== "plan") return;
      flush();
      if (kind === "plan") {
        const entries = Array.isArray(u.entries) ? (u.entries as { content?: string; status?: string }[]) : [];
        o.emit({ type: "activity", itemId: `plan-${activeTurn}`, kind: "plan", status: "completed", summary: entries.map((e) => `[${e.status ?? ""}] ${e.content ?? ""}`).join("\n"), turnId: activeTurn });
        return;
      }
      const id = text(u.toolCallId);
      const meta = (u._meta as { claudeCode?: { toolName?: string } } | undefined)?.claudeCode;
      const known = tools.get(id) ?? { tool: meta?.toolName ?? text(u.title) ?? "tool", summary: "" };
      if (meta?.toolName) known.tool = meta.toolName;
      const input = u.rawInput as Record<string, unknown> | undefined;
      if (input && Object.keys(input).length) known.summary = describeTool(input);
      else if (!known.summary && typeof u.title === "string") known.summary = u.title;
      tools.set(id, known);
      const status = u.status === "completed" ? "completed" : u.status === "failed" ? "failed" : "running";
      const toolKind = u.kind === "edit" || u.kind === "delete" || u.kind === "move" ? "file_change" : u.kind === "think" ? "reasoning" : "command";
      const output = text(u.rawOutput).trim();
      o.emit({
        type: "activity", itemId: id, kind: toolKind, status, summary: known.summary, tool: known.tool, turnId: activeTurn,
        ...(output ? { output: output.slice(0, RESULT_LIMIT) } : {}),
      });
    },
    request(method, params, id) {
      if (method !== "session/request_permission") {
        rpc.fail(id, -32601, `${method} is not supported`);
        return;
      }
      flush();
      const call = (params.toolCall ?? {}) as Record<string, unknown>;
      const input = (call.rawInput ?? {}) as Record<string, unknown>;
      const tool = text(call.name) || text((call._meta as { claudeCode?: { toolName?: string } } | undefined)?.claudeCode?.toolName) || text(call.title) || "tool";
      const options = Array.isArray(params.options) ? (params.options as { optionId: string; kind: string }[]) : [];
      const requestId = String(id);
      questions.set(requestId, { id, options });
      const approval: Approval = { requestId, tool, detail: describeTool(input), ...(typeof input.command === "string" ? { command: input.command } : {}) };
      const auto = o.decide(approval);
      if (auto) { answer(requestId, auto); return; }
      o.emit({ type: "activity", requestId, kind: "approval", status: "pending", summary: `${tool}: ${approval.detail}`, tool, turnId: activeTurn });
    },
  }, { jsonrpc: true });
  if (o.raw) rpc.onLine(o.raw);
  const exited = rpc.closed;

  function answer(requestId: string, choice: Choice): boolean {
    const q = questions.get(requestId);
    if (!q) return false;
    questions.delete(requestId);
    const want = choice === "yes" ? "allow_once" : choice === "always" ? "allow_always" : "reject_once";
    const option = q.options.find((p) => p.kind === want) ?? q.options.find((p) => p.kind.startsWith(choice === "no" ? "reject" : "allow"));
    if (!option) rpc.respond(q.id, { outcome: { outcome: "cancelled" } });
    else rpc.respond(q.id, { outcome: { outcome: "selected", optionId: option.optionId } });
    return true;
  }

  return {
    async start() {
      const init = await rpc.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      const caps = (init.agentCapabilities ?? {}) as { sessionCapabilities?: { resume?: unknown } };
      const opened = o.resume && caps.sessionCapabilities?.resume !== undefined
        ? await rpc.call("session/resume", { sessionId: o.resume, cwd: o.cwd, mcpServers: o.env.RIVET_SESSION_ID ? [{ name: "rivet", ...mcpLaunch(o.env), env: Object.entries(mcpLaunch(o.env).env).map(([name, value]) => ({ name, value })) }] : [] }).then(() => ({ sessionId: o.resume! }))
        : await rpc.call("session/new", { cwd: o.cwd, mcpServers: o.env.RIVET_SESSION_ID ? [{ name: "rivet", ...mcpLaunch(o.env), env: Object.entries(mcpLaunch(o.env).env).map(([name, value]) => ({ name, value })) }] : [] });
      sessionId = text(opened.sessionId);
      o.emit({ type: "conversation", id: sessionId, ...(o.fork && !o.resume ? { forkStrategy: "reconstructed" as const } : {}) });
      if (o.model) await rpc.call("session/set_config_option", { sessionId, configId: "model", value: o.model });
      await rpc.call("session/set_config_option", { sessionId, configId: "mode", value: CLAUDE_MODES[o.permission] ?? "default" });
    },
    async prompt(said) {
      if (o.fork && !o.resume && turn === 0) said = o.fork.context + "\n\n" + said;
      activeTurn = `t${++turn}`;
      o.emit({ type: "turn", turnId: activeTurn, state: "running" });
      try {
        const r = await rpc.call("session/prompt", { sessionId, prompt: [{ type: "text", text: said }] });
        flush();
        // The turn's own use; the totals are their sum.
        const u = (r.usage ?? {}) as Record<string, unknown>;
        if (num(u.totalTokens) !== undefined) {
          o.emit({ type: "usage", mode: "add", input: num(u.inputTokens) ?? 0, output: num(u.outputTokens) ?? 0, cached: (num(u.cachedReadTokens) ?? 0) + (num(u.cachedWriteTokens) ?? 0), total: num(u.totalTokens)! });
        }
        o.emit({ type: "turn", turnId: activeTurn, state: r.stopReason === "cancelled" ? "interrupted" : "completed" });
      } catch (e) {
        flush();
        o.emit({ type: "turn", turnId: activeTurn, state: "failed", error: (e as Error).message });
      } finally {
        activeTurn = "";
      }
    },
    async steer(said) {
      if (!activeTurn) return false;
      try {
        const r = await rpc.call("_session/steering", {
          sessionId, prompt: [{ type: "text", text: said }], _meta: { steering: { idleBehavior: "promptRequired" } },
        });
        return r.outcome === "injected";
      } catch { return false; }
    },
    async cancel() { if (activeTurn) rpc.notify("session/cancel", { sessionId }); },
    answer,
    get running() { return activeTurn !== ""; },
    close() { child.kill(); },
    exited,
  };
}

// Chat permissions: edits stay in the worktree and the agent asks when it
// wants more; otherwise no sandbox and no questions, as in the terminal.
function codexApproval(permission: string): { approvalPolicy: string; sandbox: string } {
  if (permission === "read-only") return { approvalPolicy: "never", sandbox: "read-only" };
  if (permission === "accept-edits" || permission === "auto") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  return { approvalPolicy: "never", sandbox: "danger-full-access" };
}

// Codex over its app-server.
export function codexChat(o: ChatOptions): ChatDriver {
  const child = launch(override(o.env) ?? [o.binary, "app-server"], o.cwd, o.env);
  let threadId = "";
  let forkStrategy: "native" | "reconstructed" | undefined;
  let firstForkPrompt = true;
  let activeTurn = "";
  let turnEnded: (() => void) | null = null;
  // Turns already over: turn/start's reply can arrive after its turn ended.
  const finished = new Set<string>();
  const questions = new Map<string, number | string>();
  const settings = codexApproval(o.permission);
  const stream = streamer(o.emit);
  const growing = new Map<string, string>();

  const item = (it: Record<string, unknown>, done: boolean, turnId: string) => {
    const id = text(it.id);
    switch (it.type) {
      case "agentMessage":
        if (done) {
          growing.delete(id);
          stream.done(id, text(it.text), turnId);
        }
        return;
      case "mcpToolCall": {
        const tool = `mcp:${text(it.server)}/${text(it.tool)}`;
        o.emit({ type: "activity", itemId: id, kind: "command", status: !done ? "running" : it.error || it.status === "failed" ? "failed" : "completed", summary: tool, tool, turnId,
          ...(done ? { output: text(it.error ?? it.result).slice(0, RESULT_LIMIT) } : {}) });
        return;
      }
      case "commandExecution": {
        const actions = Array.isArray(it.commandActions) ? (it.commandActions as { command?: string }[]) : [];
        const summary = actions.map((a) => a.command).filter(Boolean).join(" && ") || text(it.command);
        const output = text(it.aggregatedOutput).trim();
        const status = !done ? "running" : it.status === "completed" ? "completed" : "failed";
        o.emit({ type: "activity", itemId: id, kind: "command", status, summary, tool: "shell", turnId, ...(output ? { output: output.slice(0, RESULT_LIMIT) } : {}) });
        return;
      }
      case "fileChange": {
        const changes = Array.isArray(it.changes) ? (it.changes as { path?: string; kind?: unknown }[]) : [];
        const summary = changes.map((c) => `${typeof c.kind === "string" ? c.kind : text((c.kind as { type?: string } | undefined)?.type) || "change"} ${c.path ?? ""}`.trim()).join(", ") || "files changed";
        o.emit({ type: "activity", itemId: id, kind: "file_change", status: !done ? "running" : it.status === "failed" ? "failed" : "completed", summary, tool: "edit", turnId });
        return;
      }
      case "reasoning": {
        const summary = (Array.isArray(it.summary) ? (it.summary as unknown[]) : []).map(text).join("\n").trim();
        if (done && summary) o.emit({ type: "activity", itemId: id, kind: "reasoning", status: "completed", summary, turnId });
        return;
      }
      default:
        return;
    }
  };

  const rpc: Rpc = connect(child, {
    notify(method, params) {
      const turnId = text(params.turnId) || text((params.turn as { id?: string } | undefined)?.id) || activeTurn;
      if (method === "item/started" || method === "item/completed") item((params.item ?? {}) as Record<string, unknown>, method === "item/completed", turnId);
      else if (method === "item/agentMessage/delta") {
        const id = text(params.itemId);
        const soFar = (growing.get(id) ?? "") + text(params.delta);
        growing.set(id, soFar);
        stream.grow(id, soFar, turnId);
      } else if (method === "thread/tokenUsage/updated") {
        // Codex keeps the thread's totals itself; the last request shows how full the context is.
        const u = (params.tokenUsage ?? {}) as { total?: Record<string, unknown>; last?: Record<string, unknown>; modelContextWindow?: unknown };
        o.emit({
          type: "usage", mode: "set",
          input: num(u.total?.inputTokens) ?? 0, output: num(u.total?.outputTokens) ?? 0, cached: num(u.total?.cachedInputTokens) ?? 0, total: num(u.total?.totalTokens) ?? 0,
          ...(num(u.last?.totalTokens) !== undefined ? { contextUsed: num(u.last?.totalTokens)! } : {}),
          ...(num(u.modelContextWindow) !== undefined ? { contextWindow: num(u.modelContextWindow)! } : {}),
        });
      }
      else if (method === "turn/started") {
        activeTurn = turnId;
        o.emit({ type: "turn", turnId, state: "running" });
      } else if (method === "turn/completed") {
        const t = (params.turn ?? {}) as { status?: string; error?: { message?: string } | null };
        const state = t.status === "interrupted" ? "interrupted" : t.status === "failed" ? "failed" : "completed";
        o.emit({ type: "turn", turnId, state, ...(t.error?.message ? { error: t.error.message } : {}) });
        finished.add(turnId);
        if (turnId === activeTurn) activeTurn = "";
        turnEnded?.();
      } else if (method === "serverRequest/resolved") {
        const requestId = text(params.requestId);
        if (questions.delete(requestId)) o.emit({ type: "activity", requestId, kind: "approval", status: "resolved", summary: "answered", turnId });
      }
    },
    request(method, params, id) {
      if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") {
        rpc.fail(id, -32601, `${method} is not supported`);
        return;
      }
      const requestId = String(id);
      questions.set(requestId, id);
      const command = method === "item/commandExecution/requestApproval"
        ? ((Array.isArray(params.commandActions) ? (params.commandActions as { command?: string }[]) : []).map((a) => a.command).filter(Boolean).join(" && ") || text(params.command))
        : undefined;
      const tool = command !== undefined ? "shell" : "edit";
      const detail = command ?? (text(params.reason) || "file changes");
      const auto = o.decide({ requestId, tool, detail, ...(command !== undefined ? { command } : {}) });
      if (auto) { answer(requestId, auto); return; }
      o.emit({ type: "activity", requestId, kind: "approval", status: "pending", summary: `${tool}: ${detail}`, tool, turnId: text(params.turnId) || activeTurn });
    },
  }, { jsonrpc: false });
  if (o.raw) rpc.onLine(o.raw);

  function answer(requestId: string, choice: Choice): boolean {
    const id = questions.get(requestId);
    if (id === undefined) return false;
    // Answered here, so Codex's later "resolved" notice says nothing new.
    questions.delete(requestId);
    rpc.respond(id, { decision: choice === "yes" ? "accept" : choice === "always" ? "acceptForSession" : "decline" });
    return true;
  }

  return {
    async start() {
      await rpc.call("initialize", { clientInfo: { name: "rivet", version: "0.1.0" } });
      rpc.notify("initialized");
      const params = { cwd: o.cwd, ...settings, ...(o.env.RIVET_SESSION_ID ? { config: { mcp_servers: { rivet: mcpLaunch(o.env) } } } : {}), ...(o.model ? { model: o.model } : {}) };
      let r: Record<string, unknown>;
      if (!o.resume && o.fork?.agent === "codex" && o.fork.providerId && o.fork.turn) {
        try {
          r = await rpc.call("thread/fork", { threadId: o.fork.providerId, lastTurnId: o.fork.turn, ...params });
          forkStrategy = "native";
        } catch (e) {
          if (!(e instanceof Error) || !("code" in e) || e.code !== -32601) throw e;
          r = await rpc.call("thread/start", params);
          forkStrategy = "reconstructed";
        }
      } else {
        r = o.resume ? await rpc.call("thread/resume", { threadId: o.resume, ...params }) : await rpc.call("thread/start", params);
        if (o.fork && !o.resume) forkStrategy = "reconstructed";
      }
      threadId = text((r.thread as { id?: string } | undefined)?.id) || o.resume || "";
      if (forkStrategy === "native" && (!threadId || threadId === o.fork?.providerId)) throw new Error("provider fork returned no independent thread id");
      o.emit({ type: "conversation", id: threadId, ...(forkStrategy ? { forkStrategy } : {}) });
    },
    async prompt(said) {
      if (firstForkPrompt && forkStrategy === "reconstructed" && o.fork) said = o.fork.context + "\n\n" + said;
      firstForkPrompt = false;
      const ended = new Promise<void>((resolve) => { turnEnded = resolve; });
      let id = "";
      try {
        const r = await rpc.call("turn/start", { threadId, input: [{ type: "text", text: said }] });
        id = text((r.turn as { id?: string } | undefined)?.id);
        if (id && !activeTurn && !finished.has(id)) { activeTurn = id; o.emit({ type: "turn", turnId: id, state: "running" }); }
      } catch (e) {
        o.emit({ type: "turn", turnId: activeTurn || "start", state: "failed", error: (e as Error).message });
        return;
      }
      if (id && finished.has(id)) return;
      await Promise.race([ended, rpc.closed]);
    },
    async steer(said) {
      if (!activeTurn) return false;
      try {
        await rpc.call("turn/steer", { threadId, expectedTurnId: activeTurn, input: [{ type: "text", text: said }] });
        return true;
      } catch { return false; }
    },
    async cancel() {
      if (activeTurn) await rpc.call("turn/interrupt", { threadId, turnId: activeTurn }).catch(() => {});
    },
    answer,
    get running() { return activeTurn !== ""; },
    close() { child.kill(); },
    exited: rpc.closed,
  };
}
