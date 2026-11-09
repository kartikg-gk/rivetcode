import { nativeImages } from "./attachments.js";
import { randomUUID } from "node:crypto";
import { mcpLaunch } from "../mcp/launch.js";
import { mcpTools, toolCaller } from "../mcp/server.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describeTool } from "../timeline.js";
import { connect, RpcError, type Rpc } from "./rpc.js";

// What a conversation reports, the same for every agent. Rivet keeps it in its
// conversation tables and derives the session's activity from it.
export type ActivityKind = "shell" | "edit" | "plan" | "thinking" | "question" | "tokens" | "problem" | "note";
export type ActivityStatus = "working" | "done" | "failed" | "waiting" | "answered";
export type TurnState = "working" | "done" | "stopped" | "failed";
export type ChatEvent =
  | { type: "conversation"; id: string; forkStrategy?: "native" | "reconstructed" }
  | { type: "history"; providerId:string; items:{role:"user"|"assistant";text:string}[] }
  | { type: "turn"; turnId: string; state: TurnState; error?: string }
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
  inheritedTurns?: string[];
  fork?: { providerId: string; turn?: string; messageId?: string; agent: string; context: string };
  env: Record<string, string>;
  emit(e: ChatEvent): void;
  // Every line the agent wrote, as it came, for the record.
  raw?(line: string): void;
  // Whether Rivet's own tools run without asking (the session may run rivet).
  ownToolsFree?: boolean;
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
  cancelChild?(id: string): boolean;
  answer(requestId: string, choice: Choice): boolean;
  readonly running: boolean;
  refresh?(): Promise<void>;
  compact?(): Promise<void>;
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
  default: "default", "edits": "acceptEdits", auto: "auto", "full": "bypassPermissions", "read-only": "plan",
};

// Claude over the Agent Client Protocol.
export function claudeChat(o: ChatOptions): ChatDriver {
  const argv = override(o.env) ?? [process.execPath, claudeAdapterPath()];
  const child = launch(argv, o.cwd, { ...o.env, CLAUDE_CODE_EXECUTABLE: o.binary });
  let sessionId = "";
  let canLoad=false,loading=false;
  let loaded:{role:"user"|"assistant";text:string}[]=[];
  let loadedMessage:{role:"user"|"assistant";text:string;id:string}|undefined;
  const flushLoaded=()=>{if(loadedMessage?.text)loaded.push({role:loadedMessage.role,text:loadedMessage.text});loadedMessage=undefined;};
  const servers=()=>o.env.RIVET_SESSION_ID ? [{name:"rivet",...mcpLaunch(o.env),env:Object.entries(mcpLaunch(o.env).env).map(([name,value])=>({name,value}))}]:[];
  async function loadHistory(id:string) {
    if(!canLoad)throw new Error("provider does not advertise history loading");
    loading=true;loaded=[];loadedMessage=undefined;
    try {await rpc.call("session/load",{sessionId:id,cwd:o.cwd,mcpServers:servers()});flushLoaded();}
    finally {loading=false;}
    if(loaded.length>5000 || loaded.reduce((sum,item)=>sum+item.text.length,0)>200000)throw new Error("provider history exceeds the bounded import limit");
    return loaded;
  }
  const identity = randomUUID();
  let segment = 0;
  let turn = 0;
  let activeTurn = "";
  const commands=new Set<string>();
  const children = new Map<string, { canCancel: boolean; state: string }>();
  // Assistant text arrives in pieces; each message is kept whole once it is complete.
  let message: { id: string; text: string } | null = null;
  const tools = new Map<string, { tool: string; summary: string }>();
  const questions = new Map<string, { id: number | string; options: { optionId: string; kind: string }[] }>();
  const stream = streamer(o.emit);
  const flush = () => {
    if (message) stream.done(message.id, message.text, activeTurn);
    if (message) segment++;
    message = null;
  };
  const rpc: Rpc = connect(child, {
    notify(method, params) {
      if (method !== "session/update") return;
      const u = (params.update ?? {}) as Record<string, unknown>;
      const kind = u.sessionUpdate;
      if (sessionId && params.sessionId !== sessionId) return;
      if (kind === "subagent_update" && typeof u.sessionId === "string" && u.sessionId !== sessionId) {
        const id = u.sessionId;
        const previous = children.get(id);
        const capabilities = u.capabilities as { cancel?: unknown } | null | undefined;
        const state = u.state as { state?: string } | null | undefined;
        const childState = state === undefined ? previous?.state ?? "unknown" : state?.state ?? "unknown";
        const canCancel = capabilities === undefined ? previous?.canCancel ?? false : !!capabilities?.cancel;
        children.set(id, { canCancel, state: childState });
        o.emit({ type: "activity", kind: "note", itemId: "child-" + id,
          status: childState === "idle" ? "done" : "working",
          summary: `Claude sub-agent ${id}: ${childState}${canCancel ? " (stop available while active)" : ""}` });
        return;
      }
      if(kind==="available_commands_update"){
        commands.clear();for(const command of Array.isArray(u.availableCommands)?u.availableCommands as {name?:string}[]:[])if(command.name)commands.add(command.name);return;
      }
      if(loading){
        if(kind==="agent_message_chunk"||kind==="user_message_chunk"){
          const role=kind==="user_message_chunk"?"user":"assistant";
          const content=u.content as {type?:string;text?:string}|undefined;
          if(content?.type && content.type!=="text")return;
          const id=typeof u.messageId==="string"?u.messageId:"";
          if(loadedMessage&&(loadedMessage.role!==role||id&&loadedMessage.id!==id))flushLoaded();
          loadedMessage??={role,text:"",id};loadedMessage.text+=text(content?.text);return;
        }
        flushLoaded();return;
      }
      if (kind === "agent_message_chunk") {
        const id = typeof u.messageId === "string" ? `${identity}:${u.messageId}` : `${activeTurn}:m${segment}`;
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
        o.emit({ type: "activity", itemId: `plan-${activeTurn}`, kind: "plan", status: "done", summary: entries.map((e) => `[${e.status ?? ""}] ${e.content ?? ""}`).join("\n"), turnId: activeTurn });
        return;
      }
      const id = `${identity}:${text(u.toolCallId)}`;
      const meta = (u._meta as { claudeCode?: { toolName?: string } } | undefined)?.claudeCode;
      const known = tools.get(id) ?? { tool: meta?.toolName ?? text(u.title) ?? "tool", summary: "" };
      if (meta?.toolName) known.tool = meta.toolName;
      const input = u.rawInput as Record<string, unknown> | undefined;
      if (input && Object.keys(input).length) known.summary = describeTool(input);
      else if (!known.summary && typeof u.title === "string") known.summary = u.title;
      tools.set(id, known);
      const status = u.status === "completed" ? "done" : u.status === "failed" ? "failed" : "working";
      const toolKind = u.kind === "edit" || u.kind === "delete" || u.kind === "move" ? "edit" : u.kind === "think" ? "thinking" : "shell";
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
      const requestId = `${identity}:${String(id)}`;
      questions.set(requestId, { id, options });
      const approval: Approval = { requestId, tool, detail: describeTool(input), ...(typeof input.command === "string" ? { command: input.command } : {}) };
      const auto = o.decide(approval);
      if (auto) { answer(requestId, auto); return; }
      o.emit({ type: "activity", requestId, kind: "question", status: "waiting", summary: `${tool}: ${approval.detail}`, tool, turnId: activeTurn });
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

  let nativeFork=false;
  const driver:ChatDriver = {
    async refresh(){const items=await loadHistory(sessionId);if(o.model)await rpc.call("session/set_config_option",{sessionId,configId:"model",value:o.model});await rpc.call("session/set_config_option",{sessionId,configId:"mode",value:CLAUDE_MODES[o.permission]??"default"});o.emit({type:"history",providerId:sessionId,items});},
    async compact(){if(!commands.has("compact")||!turn)throw new Error("provider compaction is not advertised or the conversation has no turns");await driver.prompt("/compact");},
    async start() {
      const init = await rpc.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, subagents: {} } });
      const caps=(init.agentCapabilities??{}) as {loadSession?:boolean;sessionCapabilities?:{resume?:unknown;fork?:unknown}};
      canLoad=caps.loadSession===true;
      if(o.resume&&!canLoad&&caps.sessionCapabilities?.resume===undefined)throw new Error("provider does not support resuming this conversation; refusing to start a new one silently");
      let history:{role:"user"|"assistant";text:string}[]|undefined;
      if(o.resume){
        sessionId=o.resume;
        if(canLoad)history=await loadHistory(sessionId);
        else await rpc.call("session/resume",{sessionId,cwd:o.cwd,mcpServers:servers()});
      }else{
        // A fork of Claude's own conversation, pinned at the reply it branches from. The
        // adapter takes the pin through this _meta. If the reply is unknown to it, the fork
        // starts new with the history as context.
        const f=o.fork;
        if(f&&f.agent==="claude"&&f.providerId&&f.messageId&&caps.sessionCapabilities?.fork!==undefined){
          try{
            const forked=await rpc.call("session/fork",{sessionId:f.providerId,cwd:o.cwd,mcpServers:servers(),_meta:{jetbrains:{air:{fork:{version:1,messageId:f.messageId}}}}});
            sessionId=text(forked.sessionId);nativeFork=sessionId!==""&&sessionId!==f.providerId;
          }catch(e){if(!(e instanceof RpcError)||(e.code!==-32601&&e.code!==-32602))throw e;}
        }
        if(!nativeFork){const opened=await rpc.call("session/new",{cwd:o.cwd,mcpServers:servers()});sessionId=text(opened.sessionId);}
      }
      o.emit({type:"conversation",id:sessionId,...(o.fork&&!o.resume?{forkStrategy:nativeFork?"native" as const:"reconstructed" as const}:{})});
      if(history)o.emit({type:"history",providerId:sessionId,items:history});
      if (o.model) await rpc.call("session/set_config_option", { sessionId, configId: "model", value: o.model });
      await rpc.call("session/set_config_option", { sessionId, configId: "mode", value: CLAUDE_MODES[o.permission] ?? "default" });
    },
    async prompt(said) {
      if (o.fork && !o.resume && !nativeFork && turn === 0) said = o.fork.context + "\n\n" + said;
      activeTurn = `${identity}:t${++turn}`;
      o.emit({ type: "turn", turnId: activeTurn, state: "working" });
      try {
        const r = await rpc.call("session/prompt", { sessionId, prompt: [{ type: "text", text: said }, ...nativeImages(said, o.env).map(image => ({ type: "image", mimeType: image.mimeType, data: image.data }))] });
        flush();
        // The turn's own use; the totals are their sum.
        const u = (r.usage ?? {}) as Record<string, unknown>;
        if (num(u.totalTokens) !== undefined) {
          o.emit({ type: "usage", mode: "add", input: num(u.inputTokens) ?? 0, output: num(u.outputTokens) ?? 0, cached: (num(u.cachedReadTokens) ?? 0) + (num(u.cachedWriteTokens) ?? 0), total: num(u.totalTokens)! });
        }
        o.emit({ type: "turn", turnId: activeTurn, state: r.stopReason === "cancelled" ? "stopped" : "done" });
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
          sessionId, prompt: [{ type: "text", text: said }, ...nativeImages(said, o.env).map(image => ({ type: "image", mimeType: image.mimeType, data: image.data }))], _meta: { steering: { idleBehavior: "promptRequired" } },
        });
        return r.outcome === "injected";
      } catch { return false; }
    },
    async cancel() { if (activeTurn) rpc.notify("session/cancel", { sessionId }); },
    cancelChild(id) {
      const child = children.get(id);
      if (!child?.canCancel || !["running", "requires_action"].includes(child.state)) return false;
      rpc.notify("session/cancel", { sessionId: id });
      child.canCancel = false;
      return true;
    },
    answer,
    get running() { return activeTurn !== ""; },
    close() { child.kill(); },
    exited,
  };
  return driver;
}

// Chat permissions: edits stay in the worktree and the agent asks when it
// wants more; otherwise no sandbox and no questions, as in the terminal.
function codexApproval(permission: string): { approvalPolicy: string; sandbox: string } {
  if (permission === "read-only") return { approvalPolicy: "never", sandbox: "read-only" };
  if (permission === "edits" || permission === "auto") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
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
        o.emit({ type: "activity", itemId: id, kind: "shell", status: !done ? "working" : it.error || it.status === "failed" ? "failed" : "done", summary: tool, tool, turnId,
          ...(done ? { output: text(it.error ?? it.result).slice(0, RESULT_LIMIT) } : {}) });
        return;
      }
      case "commandExecution": {
        const actions = Array.isArray(it.commandActions) ? (it.commandActions as { command?: string }[]) : [];
        const summary = actions.map((a) => a.command).filter(Boolean).join(" && ") || text(it.command);
        const output = text(it.aggregatedOutput).trim();
        const status = !done ? "working" : it.status === "completed" ? "done" : "failed";
        o.emit({ type: "activity", itemId: id, kind: "shell", status, summary, tool: "shell", turnId, ...(output ? { output: output.slice(0, RESULT_LIMIT) } : {}) });
        return;
      }
      case "fileChange": {
        const changes = Array.isArray(it.changes) ? (it.changes as { path?: string; kind?: unknown }[]) : [];
        const summary = changes.map((c) => `${typeof c.kind === "string" ? c.kind : text((c.kind as { type?: string } | undefined)?.type) || "change"} ${c.path ?? ""}`.trim()).join(", ") || "files changed";
        o.emit({ type: "activity", itemId: id, kind: "edit", status: !done ? "working" : it.status === "failed" ? "failed" : "done", summary, tool: "edit", turnId });
        return;
      }
      case "reasoning": {
        const summary = (Array.isArray(it.summary) ? (it.summary as unknown[]) : []).map(text).join("\n").trim();
        if (done && summary) o.emit({ type: "activity", itemId: id, kind: "thinking", status: "done", summary, turnId });
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
        o.emit({ type: "turn", turnId, state: "working" });
      } else if (method === "turn/completed") {
        const t = (params.turn ?? {}) as { status?: string; error?: { message?: string } | null };
        const state = t.status === "interrupted" ? "stopped" : t.status === "failed" ? "failed" : "done";
        o.emit({ type: "turn", turnId, state, ...(t.error?.message ? { error: t.error.message } : {}) });
        finished.add(turnId);
        if (turnId === activeTurn) activeTurn = "";
        turnEnded?.();
      } else if (method === "serverRequest/resolved") {
        const requestId = text(params.requestId);
        if (questions.delete(requestId)) o.emit({ type: "activity", requestId, kind: "question", status: "answered", summary: "answered", turnId });
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
      o.emit({ type: "activity", requestId, kind: "question", status: "waiting", summary: `${tool}: ${detail}`, tool, turnId: text(params.turnId) || activeTurn });
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

  async function refresh() {
    const response = await rpc.call("thread/read",{threadId,includeTurns:true});
    const thread = response.thread as {turns?: {id:string;status:string;items?:Record<string,unknown>[]}[]} | undefined;
    if (!Array.isArray(thread?.turns)) throw new Error("provider history is unavailable");
    const excluded = new Set(o.inheritedTurns ?? []);
    for (const turn of thread.turns) {
      if (excluded.has(turn.id) || !["completed","interrupted","failed"].includes(turn.status)) continue;
      if (!Array.isArray(turn.items)) continue;
      o.emit({type:"turn",turnId:turn.id,state:"working"});
      for (const entry of turn.items) {
        if (entry.type === "userMessage") {
          const content = Array.isArray(entry.content) ? entry.content as {text?:string}[] : [];
          const text = content.map(c=>c.text ?? "").join("\n");
          if (text) o.emit({type:"message",itemId:String(entry.id),role:"user",text,turnId:turn.id});
        } else item(entry,true,turn.id);
      }
      o.emit({type:"turn",turnId:turn.id,state:turn.status==="interrupted"?"stopped":turn.status==="failed"?"failed":"done"});
    }
  }
  return {
    refresh,
    async compact() {if(activeTurn)throw new Error("wait for idle before compaction");await rpc.call("thread/compact/start",{threadId});},
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
      if (o.resume) await refresh().catch((e: Error) => o.emit({type:"activity",kind:"note",status:"failed",summary:`Provider history refresh unavailable: ${e.message}`}));
    },
    async prompt(said) {
      if (firstForkPrompt && forkStrategy === "reconstructed" && o.fork) said = o.fork.context + "\n\n" + said;
      firstForkPrompt = false;
      const ended = new Promise<void>((resolve) => { turnEnded = resolve; });
      let id = "";
      try {
        const r = await rpc.call("turn/start", { threadId, input: [{ type: "text", text: said }, ...nativeImages(said, o.env).map(image => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` }))] });
        id = text((r.turn as { id?: string } | undefined)?.id);
        if (id && !activeTurn && !finished.has(id)) { activeTurn = id; o.emit({ type: "turn", turnId: id, state: "working" }); }
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
        await rpc.call("turn/steer", { threadId, expectedTurnId: activeTurn, input: [{ type: "text", text: said }, ...nativeImages(said, o.env).map(image => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` }))] });
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

// Delta's model is "provider/model" (its own catalog's names); either half may be left out.
export function deltaModel(model: string | undefined): { provider?: string; model?: string } {
  const m = model?.trim();
  if (!m) return {};
  const at = m.indexOf("/");
  return at < 0 ? { model: m } : { ...(at > 0 ? { provider: m.slice(0, at) } : {}), ...(m.slice(at + 1) ? { model: m.slice(at + 1) } : {}) };
}

// Where a delta session's logs and Rivet's files for it go.
export function deltaLogs(env: Record<string, string>, cwd: string): string {
  return env.DELTA_LOG_DIR ?? join(env.RIVET_DATA_DIR ?? cwd, "logs", "delta", env.RIVET_SESSION_ID ?? "session");
}

// Delta asks before any tool but reads; Rivet's levels decide which questions reach the user.
const DELTA_POLICY: Record<string, string> = { "read-only": "deny", auto: "auto", "full": "auto" };
const DELTA_EDITS = new Set(["Edit", "Write", "MultiEdit"]);

// Delta over its own JSON-lines protocol (--mode rpc): one record per line each way.
export function deltaChat(o: ChatOptions): ChatDriver {
  const { provider, model } = deltaModel(o.model);
  const argv = override(o.env) ?? [o.binary, "--mode", "rpc", "--cwd", o.cwd, "--tool-policy", DELTA_POLICY[o.permission] ?? "ask",
    ...(provider ? ["--provider", provider] : []), ...(model ? ["--model", model] : []), ...(o.resume ? ["--resume", o.resume] : [])];
  // Delta logs each run under the folder it works in unless told otherwise; in a worktree
  // those logs would be committed with the work, so they go to Rivet's data folder.
  const logs = deltaLogs(o.env, o.cwd);
  // Rivet's own tools reach delta as tools it calls and Rivet answers (the same ones Claude
  // and Codex get over MCP), so it need not type rivet commands into a shell.
  const call = o.env.RIVET_SESSION_ID ? toolCaller(o.env, o.cwd) : null;
  if (call && !override(o.env)) {
    mkdirSync(logs, { recursive: true });
    const file = join(logs, "rivet-tools.json");
    writeFileSync(file, JSON.stringify(mcpTools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema, ...(o.ownToolsFree ? { approval: false } : {}) }))));
    argv.push("--host-tools-file", file);
  }
  const child = launch(argv, o.cwd, { ...o.env, DELTA_LOG_DIR: logs });
  const s = streamer(o.emit);
  const waiting = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  const questions = new Map<string, string>();
  const always = new Set<string>();
  let next = 0, turns = 0, item = 0;
  let activeTurn = "", itemId = "";
  let settled: (() => void) | undefined;
  // What delta prints on stderr is its own account of a failure; its last plain lines (not a
  // traceback's indented frames) say why.
  let errors = "";
  const why = () => errors.split(/\r?\n/).filter((l) => l.trim() && !/^\s/.test(l) && !l.startsWith("Traceback (")).slice(-2).join("\n").slice(-500);
  const exited = new Promise<void>((resolve) => child.on("exit", (code) => {
    const said = why();
    for (const w of waiting.values()) w.reject(new Error(said ? `delta exited: ${said}` : "delta exited"));
    if (activeTurn) { o.emit({ type: "turn", turnId: activeTurn, state: "failed", error: said || `delta exited (${code ?? "killed"})` }); activeTurn = ""; }
    waiting.clear();
    settled?.();
    resolve();
  }));
  const send = (type: string, fields: Record<string, unknown> = {}): Promise<unknown> => {
    const id = `r${++next}`;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      child.stdin!.write(JSON.stringify({ id, type, ...fields }) + "\n");
    });
  };
  const segments = (m: Record<string, unknown>) => (Array.isArray(m.content) ? m.content as Record<string, unknown>[] : []);
  const said = (m: Record<string, unknown>) => segments(m).filter((c) => c.type === "text").map((c) => text(c.text)).join("");
  function answer(requestId: string, choice: Choice): boolean {
    const tool = questions.get(requestId);
    if (tool === undefined) return false;
    questions.delete(requestId);
    if (choice === "always") always.add(tool);
    void send("respond_to_approval", { approvalId: requestId, allow: choice !== "no" }).catch(() => {});
    return true;
  }
  const onEvent = (e: Record<string, unknown>) => {
    const m = (e.message ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case "response": {
        const w = waiting.get(text(e.id));
        if (!w) return;
        waiting.delete(text(e.id));
        if (e.success) w.resolve(e.data); else w.reject(new Error(text(e.error) || "delta refused the request"));
        return;
      }
      case "message_start":
        if (m.role === "assistant") itemId = `delta-${activeTurn}-${++item}`;
        return;
      case "message_update":
        if (m.role === "assistant" && itemId) { const t = said(m); if (t) s.grow(itemId, t, activeTurn); }
        return;
      case "message_end": {
        if (m.role !== "assistant") return;
        s.done(itemId, said(m), activeTurn);
        const u = (m.usage ?? {}) as Record<string, unknown>;
        if (num(u.totalTokens)) o.emit({ type: "usage", mode: "add", ...(num(u.input) !== undefined ? { input: num(u.input)! } : {}), ...(num(u.output) !== undefined ? { output: num(u.output)! } : {}), ...(num(u.cacheRead) !== undefined ? { cached: num(u.cacheRead)! } : {}), total: num(u.totalTokens)! });
        return;
      }
      case "tool_execution_start":
      case "tool_execution_end": {
        const tool = text(e.toolName);
        const done = e.type === "tool_execution_end";
        const result = done ? segments((e.result ?? {}) as Record<string, unknown>).filter((c) => c.type === "text").map((c) => text(c.text)).join("") : "";
        o.emit({ type: "activity", itemId: text(e.toolCallId), kind: DELTA_EDITS.has(tool) ? "edit" : "shell", status: !done ? "working" : e.isError ? "failed" : "done",
          summary: done ? tool : describeTool(e.args), tool, turnId: activeTurn, ...(result ? { output: result.slice(0, RESULT_LIMIT) } : {}) });
        return;
      }
      case "approval_requested": {
        const requestId = text(e.approvalId), tool = text(e.tool);
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(text(e.preview)) as Record<string, unknown>; } catch { /* shown as given */ }
        questions.set(requestId, tool);
        const approval: Approval = { requestId, tool, detail: Object.keys(input).length ? describeTool(input) : text(e.preview), ...(typeof input.command === "string" ? { command: input.command } : {}) };
        const auto = always.has(tool) || (o.permission === "edits" && DELTA_EDITS.has(tool)) ? "yes" : o.decide(approval);
        if (auto) { answer(requestId, auto); return; }
        o.emit({ type: "activity", requestId, kind: "question", status: "waiting", summary: `${tool}: ${approval.detail}`, tool, turnId: activeTurn });
        return;
      }
      case "host_tool_call": {
        const callId = text(e.callId);
        const reply = (output: string, isError: boolean) => void send("respond_to_host_tool", { callId, output: output.slice(0, 200_000), isError }).catch(() => {});
        if (!call) { reply("Rivet's tools are not available to this session.", true); return; }
        void call(text(e.name), e.arguments ?? {}).then((r) => reply(JSON.stringify(r ?? null), false), (err: Error) => reply(err.message, true));
        return;
      }
      case "approval_resolved":
        // Delta lets a question expire; one Rivet answered was removed when it did.
        if (questions.delete(text(e.approvalId))) o.emit({ type: "activity", requestId: text(e.approvalId), kind: "question", status: "answered", summary: "expired", turnId: activeTurn });
        return;
      case "agent_settled": {
        const outcome = text(e.outcome);
        o.emit({ type: "turn", turnId: activeTurn, state: outcome === "completed" ? "done" : outcome === "cancelled" ? "stopped" : "failed",
          ...(e.error ? { error: text(e.error) } : outcome !== "completed" && outcome !== "cancelled" && why() ? { error: why() } : {}) });
        activeTurn = "";
        void send("get_session_stats").then((st) => {
          const c = ((st ?? {}) as Record<string, unknown>).contextUsage as Record<string, unknown> | undefined;
          if (c) o.emit({ type: "usage", mode: "add", ...(num(c.tokens) !== undefined ? { contextUsed: num(c.tokens)! } : {}), ...(num(c.contextWindow) !== undefined ? { contextWindow: num(c.contextWindow)! } : {}) });
        }).catch(() => {});
        settled?.();
        return;
      }
    }
  };
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      o.raw?.(line);
      try { onEvent(JSON.parse(line) as Record<string, unknown>); } catch { /* not a record */ }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString("utf8")).slice(-4000); });
  return {
    async start() {
      // Rivet titles its own runs. Unnamed, delta asks the model for a title after the first
      // reply and every few after, which holds the turn open (minutes on a local model).
      await send("set_session_name", { name: `rivet ${o.env.RIVET_SESSION_ID ?? "session"}` }).catch(() => {});
      const st = (await send("get_state")) as Record<string, unknown>;
      // The session file is what --resume takes; without one, the id at least names it.
      o.emit({ type: "conversation", id: text(st.sessionFile) || text(st.sessionId) });
    },
    async prompt(message) {
      activeTurn = `turn-${++turns}`;
      o.emit({ type: "turn", turnId: activeTurn, state: "working" });
      const ended = new Promise<void>((resolve) => { settled = resolve; });
      try { await send("prompt", { message }); }
      catch (e) { o.emit({ type: "turn", turnId: activeTurn, state: "failed", error: (e as Error).message }); activeTurn = ""; return; }
      await Promise.race([ended, exited]);
    },
    async steer(message) {
      if (!activeTurn) return false;
      try { await send("steer", { message, requireActive: true }); return true; } catch { return false; }
    },
    async cancel() { if (activeTurn) await send("abort").catch(() => {}); },
    answer,
    get running() { return activeTurn !== ""; },
    async compact() { await send("compact"); },
    close() {
      void send("shutdown").catch(() => {});
      setTimeout(() => child.kill(), 3000).unref();
    },
    exited,
  };
}
