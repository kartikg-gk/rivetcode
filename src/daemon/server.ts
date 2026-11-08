import { listFiles, readTextFile, saveTextFile, WorkspaceError } from "./workspace.js";
import { extractDocument } from "./documents.js";
import { linkListed } from "../links.js";
import { saveAttachments } from "./attachments.js";
import { cleanupQueue } from "./cleanup.js";
import { allowedRequest, liveSocket, serveApp } from "./web.js";
import { parseTaskFile, TaskFileError } from "../scheduler/tasks.js";
import { searchPage, SearchInputError } from "../search.js";
import { forkConversation, mergeConversation } from "../scheduler/conversations.js";
import { existsSync } from "node:fs";
import { waitForRun } from "../scheduler/wait.js";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { getAgent, type Agent } from "../agents/agent.js";
import { findClaude, findCodex } from "../agents/locate.js";
import { githubClient, githubToken, repoSlug, type GitHub } from "../github/github.js";
import { dataDir, assertId, defaultProjectId, branchName, worktreePath } from "../paths.js";
import { git } from "../git.js";
import { liveOwner, releaseRunFile, runFilePath, writeRunFile, type RunInfo } from "../runfile.js";
import { sessionIdOf } from "../runtime/env.js";
import { createRuntime } from "../runtime/runtime.js";
import { radar } from "../scheduler/radar.js";
import { cleanRun, copyListed, MODEL_FAMILIES, prepareRun, repoRoot, runSetup, RunInputError, SetupError, type NewRun } from "../scheduler/runs.js";
import { IssueRefError, issueNumber, issueTask } from "../scheduler/issue.js";
import { checkSnippet } from "../scheduler/snippets.js";
import { checkSpec, outsidePaths, type TaskSpec } from "../scheduler/tasks.js";
import { redact, MESSAGE_KINDS, TIMELINE_KINDS, type TimelineEntry, type TimelineKind } from "../timeline.js";

// Timeline entries a hook sent, kept only when well formed.
function checkEntries(raw: unknown): TimelineEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is TimelineEntry => !!e && typeof e === "object" && TIMELINE_KINDS.includes((e as { kind: TimelineKind }).kind)
    && typeof (e as { text: unknown }).text === "string" && ((e as { tool?: unknown }).tool === undefined || typeof (e as { tool?: unknown }).tool === "string"))
    .slice(0, 50);
}
// What a chat host reports, checked field by field; anything else is dropped.
const CHAT_KINDS = ["shell", "edit", "plan", "thinking", "question", "tokens", "problem", "note"];
const CHAT_STATUSES = ["working", "done", "failed", "waiting", "answered"];
const TURN_STATES = ["working", "done", "stopped", "failed"];
const CHAT_TEXT_LIMIT = 100_000;
function checkChatEvents(raw: unknown): ChatEvent[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => typeof v === "string";
  const cut = (v: string) => v.slice(0, CHAT_TEXT_LIMIT);
  const out: ChatEvent[] = [];
  for (const e of raw.slice(0, 500) as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "conversation" && str(e.id)) out.push({ type: "conversation", id: (e.id as string).slice(0, 200), ...(["native", "reconstructed"].includes(e.forkStrategy as string) ? { forkStrategy: e.forkStrategy as "native" | "reconstructed" } : {}) });
    else if (e.type === "turn" && str(e.turnId) && TURN_STATES.includes(e.state as string)) {
      out.push({ type: "turn", turnId: e.turnId as string, state: e.state as "working", ...(str(e.error) ? { error: cut(e.error as string) } : {}) });
    } else if (e.type === "message" && str(e.itemId) && str(e.text) && (e.role === "user" || e.role === "assistant")) {
      out.push({ type: "message", itemId: e.itemId as string, role: e.role, text: cut(e.text as string), ...(str(e.turnId) ? { turnId: e.turnId as string } : {}), ...(e.streaming === true ? { streaming: true } : {}) });
    } else if(e.type==="history"){
      if(!str(e.providerId)||!Array.isArray(e.items)||e.items.length>5000)throw new HttpError(400,"invalid provider history");
      const items=e.items as {role:unknown;text:unknown}[];
      if(items.some(item=>!item||!["user","assistant"].includes(String(item.role))||!str(item.text))||items.reduce((size,item)=>size+String(item.text).length,0)>200000)throw new HttpError(400,"provider history exceeds import bounds");
      out.push({type:"history",providerId:e.providerId as string,items:items as {role:"user"|"assistant";text:string}[]});
    } else if (e.type === "usage" && (e.mode === "add" || e.mode === "set")) {
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? { ok: true as const, v } : null);
      const fields = ["input", "output", "cached", "total", "contextUsed", "contextWindow"] as const;
      out.push({ type: "usage", mode: e.mode, ...Object.fromEntries(fields.filter((f) => n(e[f])).map((f) => [f, e[f] as number])) });
    } else if (e.type === "activity" && CHAT_KINDS.includes(e.kind as string) && CHAT_STATUSES.includes(e.status as string) && str(e.summary)) {
      out.push({
        type: "activity", kind: e.kind as "shell", status: e.status as "working", summary: cut(e.summary as string),
        ...(str(e.itemId) ? { itemId: e.itemId as string } : {}), ...(str(e.requestId) ? { requestId: e.requestId as string } : {}),
        ...(str(e.tool) ? { tool: (e.tool as string).slice(0, 100) } : {}), ...(str(e.output) ? { output: cut(e.output as string) } : {}),
        ...(str(e.turnId) ? { turnId: e.turnId as string } : {}),
      });
    }
  }
  return out;
}
import type { ChatEvent } from "../chat/drivers.js";
import { secretKeeper } from "./secrets.js";
import { checkZone, nextRun, parseCron } from "../scheduler/cron.js";
import { createScheduler, SchedulerError } from "../scheduler/scheduler.js";
import { openStore, RunStoreError, SEND_MODES, type Run, type SendMode } from "../store.js";
import { runUsage } from "../usage.js";
import { ACTIVITY_STATES, AGENTS, NODE_ID, noSignal, ROLES, type ActivityState, type Node, type Role } from "../model.js";
import { vaultResolver } from "./vault.js";
import { createWorktree, emptyTrash, removeWorktree } from "../worktree.js";

const BODY_LIMIT = 1024 * 1024;
const DIFF_LIMIT = 2 * 1024 * 1024;
// Per-project settings: the check and the tests a worker's work must pass, the default agent.
const CONFIG_KEYS = [
  "feedback.ciRetries",
  "feedback.reviewMinutes",
  "check",
  "test",
  "verify.reuse",
  "worker.agent",
  "worker.permission",
  "worker.model",
  "claude.model",
  "codex.model",
  "delta.model",
  "delta.binary",
  "worker.allowedTools",
  "worker.mode",
  "pr",
  "review",
  "review.agent",
  "pr.feedback",
  "github.repo",
  "copy",
  "symlink",
  "setup",
  "timeline.keep",
  "session.mode",
];
// Days a finished run's timeline is kept unless timeline.keep says otherwise ("forever" keeps it).
const TIMELINE_KEEP_DAYS = 30;
const REPORT_KINDS = ["done", "blocked", "question"] as const;
type ReportKind = (typeof REPORT_KINDS)[number];

// stopped resolves once the daemon has fully shut down (by stop(), a signal or /shutdown).
export type Daemon = { port: number; stop(): Promise<void>; stopped: Promise<void>; idle(): Promise<void> };
export type DaemonOptions = {
  notify?(notice: import("./notifications.js").DesktopNotice): Promise<void>;
  data?: string;
  runFile?: string;
  port?: number;
  // Which adapter runs a node's agent; tests swap in the fake agent.
  agents?: (name: Node["agent"]) => Agent;
  stopGraceMs?: number;
  checkTimeoutMs?: number;
  // GitHub access for a run (tests pass a client for a mock API).
  github?(run: Run): Promise<GitHub>;
  // How often open pull requests are checked.
  prWatchMs?: number;
  // How often workers' branches are checked for clashes to tell their orchestrators about.
  radarMs?: number;
  // How often due routines are looked for.
  routineMs?: number;
  // How often finished runs' old timelines are removed.
  pruneMs?: number;
  // How long a switch waits for a working agent to finish its turn.
  switchWaitMs?: number;
  // How often workers are checked against their task's time and token limits.
  limitMs?: number;
  // Problems the scheduler handled by escalating or could not handle; for logs and tests.
  onError?(error: unknown): void;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function reply(res: ServerResponse, status: number, value?: unknown): void {
  if (value === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    req.once("end", resolve);
    req.once("error", reject);
  });
  if (size > BODY_LIMIT) throw new HttpError(413, "body exceeds 1 MiB");
  if (size === 0) return {};
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function session(value: unknown): { runId: string; nodeId: string } {
  if (typeof value !== "string") throw new HttpError(400, "invalid session id");
  const split = value.indexOf("-");
  if (split < 1 || split === value.length - 1) throw new HttpError(400, "invalid session id");
  const runId = value.slice(0, split);
  const nodeId = value.slice(split + 1);
  try {
    assertId("run", runId);
    assertId("node", nodeId);
  } catch { throw new HttpError(400, "invalid session id"); }
  return { runId, nodeId };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string`);
  return value;
}

function loopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

function loopbackPeer(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function healthy(owner: RunInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${owner.port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const value: unknown = await response.json();
    return !!value && typeof value === "object" &&
      (value as Record<string, unknown>).service === "rivet-daemon" &&
      (value as Record<string, unknown>).pid === owner.pid;
  } catch { return false; }
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const data = opts.data ?? dataDir();
  const runFile = opts.runFile ?? runFilePath();
  const owner = await liveOwner(runFile);
  if (owner && await healthy(owner)) {
    throw new Error(`daemon already running (pid ${owner.pid}, port ${owner.port}); refusing to start`);
  }

  const secrets = secretKeeper(data);
  const store = openStore(data);
  try {
    store.exitStaleSessions();
    await emptyTrash(data);
    await secrets.clear();
  } catch (error) { store.close(); throw error; }

  let claudeBinary: string | undefined;
  let codexBinary: string | undefined;
  const agents = opts.agents ?? ((name: Node["agent"]) => {
    if (name === "codex") {
      try { codexBinary ??= findCodex(); }
      catch (e) { throw new HttpError(409, (e as Error).message); }
      return getAgent("codex", { binary: codexBinary });
    }
    if (name === "claude") {
      try { claudeBinary ??= findClaude(); }
      catch (e) { throw new HttpError(409, (e as Error).message); }
      return getAgent("claude", { binary: claudeBinary });
    }
    return getAgent(name);
  });
  const runtime = createRuntime({ logDir: join(data, "logs"), ...(opts.stopGraceMs ? { stopGraceMs: opts.stopGraceMs } : {}) });
  // The launch each session is on now; hooks and exits of older launches are ignored.
  const launches = new Map<string, string>();

  let queue = Promise.resolve();
  function write<T>(work: () => T): Promise<T> {
    const result = queue.then(work);
    queue = result.then(() => {}, () => {});
    return result;
  }

  const github = opts.github ?? (async (run: Run): Promise<GitHub> => {
    const remote = (await git(["remote", "get-url", "origin"], run.repo).catch(() => "")).trim();
    const config = await write(() => store.getConfig(run.project));
    const repo = config["github.repo"] ?? repoSlug(remote);
    if (!repo) throw new Error(`origin is not a GitHub repository (${remote || "no origin"}); set github.repo`);
    return githubClient({ repo, token: await githubToken(process.env, remote) });
  });
  const branchChanges = new Set<string>();
  const scriptRuns = new Map<string, { session: string; script: string; worktree: string; starting: boolean }>();
  runtime.onExit((sessionId, _launchId, code) => {
    for (const [runId, script] of scriptRuns) {
      if (script.session !== sessionId) continue;
      void write(() => store.addTimeline(runId.split(":")[0]!, NODE_ID, [{ kind: "event", text: `Workspace process ${script.script} exited with status ${code ?? "unknown"}` }])).catch(error => opts.onError?.(error));
    }
  });
  const subagents = new Map<string, { launch: string; children: Map<string, { id: string; label: string; status: string; canCancel: boolean }> }>();
  const vault = vaultResolver();
  runtime.onExit((sessionId,launchId) => { const id = sessionId.replace(/-agent$/, ""); if (subagents.get(id)?.launch === launchId) subagents.delete(id); });
  let notificationScanAt = 0;
  let notificationWork: Promise<void> | undefined;
  async function checkNotifications() {
    if (Date.now() - notificationScanAt < 1000) return;
    notificationScanAt = Date.now();
    const notices = await write(() => {
      const result: import("./notifications.js").DesktopNotice[] = [];
      for (const id of store.listRuns()) {
        const run = store.loadRun(id), node = run.node;
        const request = scheduler.pendingRequest(id);
        const secret = secrets.pending(sessionIdOf(id,NODE_ID));
        const state = secret ? "secret:"+secret.id : request ? "approval:"+request.at : node.activity === "approval" ? "approval:"+node.activityAt : node.activity === "asking" ? "question:"+node.activityAt : ["done","escalated"].includes(node.status) ? node.status+":"+node.attempts : "";
        const previous = store.lifecycleState(id,"desktop-notice");
        const seen = {...previous.reactions};
        const numbers = new Set([store.getPr(id)?.number,...store.linkedPrs(id).map(pr=>pr.number)]);
        for (const number of numbers) {
          if (number === undefined) continue;
          const reaction = store.lifecycleState(id,"pr-feedback:"+number);
          const identity = reaction.attention ? reaction.attention+":"+(reaction.approvedSha ?? "") : "";
          if (identity && seen[number] !== identity) {
            result.push({title:"Rivet",body:id+": "+reaction.attention});
            seen[number] = identity;
          }
        }
        if (JSON.stringify(seen) !== JSON.stringify(previous.reactions ?? {})) store.saveLifecycleState(id,"desktop-notice",{...previous,reactions:seen});
        if (previous.state === state) continue;
        store.saveLifecycleState(id,"desktop-notice",{state,reactions:seen});
        if (!state) continue;
        store.organizeRun(id,{unread:true});
        const reason = secret ? "A secret is requested" : request || node.activity === "approval" ? "Approval is requested" : node.activity === "asking" ? "An answer is requested" : node.status === "done" ? "Task finished" : "Task needs attention";
        result.push({title:"Rivet",body:id+": "+reason+". Open Rivet to review."});
      }
      return result;
    });
    if (opts.notify) { for (const notice of notices) await opts.notify(notice); }
    else if (notices.length) {
      const notice = notices.length === 1 ? notices[0]! : {title:"Rivet",body:notices.length+" updates need your attention. Open Rivet to review."};
      await import("./notifications.js").then(m=>m.desktopNotify(notice));
    }
  }
  let wakeTimer: NodeJS.Timeout | undefined;
  const waitAbort = new AbortController();
  // A secret given to a session goes when the session does.
  runtime.onExit((sessionId) => { void secrets.forget(sessionId).catch(() => {}); });
  const scheduler = createScheduler({
    data, runFile, store, write, runtime, agents, launches, github,
    ...(opts.checkTimeoutMs ? { checkTimeoutMs: opts.checkTimeoutMs } : {}),
    onError: (error) => { opts.onError?.(error); },
    workspaceBusy: path => [...scriptRuns.values()].some(process => process.worktree === path && (process.starting || runtime.isAlive(process.session))),
  });

  const cleanup = cleanupQueue(async (runId) => {
    const run = await write(() => store.loadRun(runId));
    await scheduler.stopSession(sessionIdOf(run.id, run.node.id));
    if (run.sharedWorkspace) {
      await write(() => store.detachFork(run.id));
      return { removed: [], kept: [run.node.id], detached: true };
    }
    return scheduler.cleanWorkspace(run);
  });

  // Creates a run with the project's settings and starts its agent.
  async function newRun(o: Omit<NewRun, "data" | "defaultAgentFor" | "copyFor" | "setupFor">): Promise<Run> {
    const root = await repoRoot(o.repo);
    if (await write(() => store.projectDeleted(defaultProjectId(root)))) throw new HttpError(409, "register the deleted project before starting new runs");
    const run = await prepareRun({
      ...o, data,
      defaultAgentFor: (project) => store.getConfig(project)["worker.agent"],
      copyFor: (project) => (store.getConfig(project).copy ?? "").split(",").map((f) => f.trim()).filter(Boolean),
      linkFor: (project) => (store.getConfig(project).symlink ?? "").split(",").map((f) => f.trim()).filter(Boolean),
      // One command per line, run in order in every new worktree.
      setupFor: (project) => (store.getConfig(project).setup ?? "").split(/\r?\n/).map((c) => c.trim()).filter(Boolean),
    });
    await write(() => store.saveRun(run));
    void scheduler.startRun(run.id).catch((e) => opts.onError?.(e));
    return run;
  }

  // Routines whose time has come start their run; each is moved to its next time first,
  // so a failure is recorded once and not retried every tick. A time missed while the
  // daemon was down runs once.
  async function runDueRoutines(now = new Date()): Promise<void> {
    const due = await write(() => store.listRoutines().filter((a) => a.enabled && Date.parse(a.nextRunAt) <= now.getTime()));
    for (const a of due) {
      const next = nextRun(parseCron(a.cron), a.zone, now).toISOString();
      await write(() => store.saveRoutine({ ...a, nextRunAt: next, lastRunAt: now.toISOString() }));
      try {
        const run = await newRun({ repo: a.repo, task: a.prompt, role: a.role, name: a.name, ...(a.agent ? { agent: a.agent } : {}) });
        await write(() => store.recordRoutineRun({ routineId: a.id, scheduledFor: a.nextRunAt, runId: run.id, createdAt: now.toISOString() }));
      } catch (error) {
        await write(() => store.recordRoutineRun({ routineId: a.id, scheduledFor: a.nextRunAt, error: (error as Error).message, createdAt: now.toISOString() }));
        opts.onError?.(error);
      }
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      const status = error instanceof HttpError || error instanceof SchedulerError ? error.status : 500;
      const message = error instanceof Error ? error.message : "internal error";
      reply(res, status, { error: message });
    });
  });

  // Starts a session's agent by hand with the given prompt; its status is not touched.
  async function startSession(runId: string, nodeId: string, prompt?: string): Promise<string> {
    let run;
    try { run = await write(() => store.loadRun(runId)); }
    catch (error) {
      if (error instanceof RunStoreError) throw new HttpError(404, "unknown session");
      throw error;
    }
    if (run.node.id !== nodeId) throw new HttpError(404, "unknown session");
    return scheduler.launch(run, prompt);
  }

  const live = liveSocket({ server, runtime, changeCount: () => store.changeCount(), sessionOf: (id) => { const s = session(id); return sessionIdOf(s.runId, s.nodeId); } });
  let stopping: Promise<void> | undefined;
  let markStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { markStopped = resolve; });
  const onSignal = () => { void stop(); };
  let routineTimer: NodeJS.Timeout | undefined;
  let pruneTimer: NodeJS.Timeout | undefined;
  // Finished runs' timelines go after timeline.keep days: they hold tool output, which can
  // carry what redaction misses.
  async function pruneTimelines(): Promise<void> {
    await write(() => {
      for (const project of store.listProjects()) {
        const keep = store.getConfig(project)["timeline.keep"];
        if (keep === "forever") continue;
        const days = keep !== undefined && Number(keep) >= 0 ? Number(keep) : TIMELINE_KEEP_DAYS;
        store.pruneTimeline(project, new Date(Date.now() - days * 86_400_000).toISOString());
      }
    });
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (routineTimer) clearInterval(routineTimer);
      if (pruneTimer) clearInterval(pruneTimer);
      if (wakeTimer) clearInterval(wakeTimer);
      waitAbort.abort();
      live.close();
      await cleanup.close();
      await scheduler.shutdown();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await notificationWork;
      await queue;
      store.close();
      await releaseRunFile(runFile, process.pid);
      markStopped();
    })();
    return stopping;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (!allowedRequest(req.headers)) {
      reply(res, 403, { status: "forbidden" });
      return;
    }
    if (path === "/healthz") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      reply(res, 200, { status: "ok", service: "rivet-daemon", pid: process.pid });
      return;
    }
    if (path === "/shutdown") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const origin = req.headers.origin;
      if (!loopbackPeer(req.socket.remoteAddress) || !loopbackOrigin(origin)) {
        reply(res, 403, { status: "forbidden" });
        return;
      }
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "shutting_down", pid: process.pid }), () => { void stop(); });
      return;
    }
    const control = /^\/api\/v1\/sessions\/([^/]+)\/(start|stop|output|attach|input|resize)$/.exec(path);
    if (control) {
      const [, id, action] = control;
      const { runId, nodeId } = session(id);
      const sessionId = sessionIdOf(runId, nodeId);
      if (action === "attach") {
        if (req.method !== "GET") throw new HttpError(405, "method not allowed");
        // Streams the terminal: recent output first, then everything new, until exit.
        let ended = false;
        let watch: { replay: string; detach(): void } | null = null;
        const finish = () => {
          if (ended) return;
          ended = true;
          watch?.detach();
          offExit();
          res.end();
        };
        const offExit = runtime.onExit((s) => { if (s === sessionId) finish(); });
        watch = runtime.attach(sessionId, (chunk) => { if (!ended) res.write(chunk); });
        if (!watch) { offExit(); throw new HttpError(404, "session has not been started"); }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.write(watch.replay);
        req.on("close", finish);
        if (!runtime.isAlive(sessionId)) finish();
        return;
      }
      if (action === "input" || action === "resize") {
        if (req.method !== "POST") throw new HttpError(405, "method not allowed");
        if (!runtime.isAlive(sessionId)) throw new HttpError(404, "session is not running");
        const payload = await body(req);
        try {
          if (action === "input") {
            if (typeof payload.data !== "string") throw new HttpError(400, "data must be a string");
            runtime.input(sessionId, payload.data);
          } else {
            const { cols, rows } = payload;
            if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 1 || (rows as number) < 1) {
              throw new HttpError(400, "cols and rows must be positive integers");
            }
            runtime.resize(sessionId, cols as number, rows as number);
          }
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(409, (error as Error).message);
        }
        reply(res, 204);
        return;
      }
      if (action === "output") {
        if (req.method !== "GET") throw new HttpError(405, "method not allowed");
        const raw = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("lines");
        const lines = raw === null ? 200 : Number(raw);
        if (!Number.isInteger(lines) || lines < 1) throw new HttpError(400, "lines must be a positive integer");
        const out = runtime.output(sessionId, Math.min(lines, 2000));
        if (!out) throw new HttpError(404, "session has not been started");
        reply(res, 200, out);
        return;
      }
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      if (action === "stop") {
        if (!runtime.isAlive(sessionId)) throw new HttpError(404, "session is not running");
        await scheduler.stopSession(sessionId);
        reply(res, 204);
        return;
      }
      const payload = await body(req);
      const prompt = optionalString(payload.prompt, "prompt");
      reply(res, 202, { launchId: await startSession(runId, nodeId, prompt) });
      return;
    }
    const activity = /^\/api\/v1\/sessions\/([^/]+)\/activity$/.exec(path);
    if (activity) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const { runId, nodeId } = session(activity[1]);
      const payload = await body(req);
      const launchId = optionalString(payload.launchId, "launchId");
      if (launchId !== undefined && launches.get(sessionIdOf(runId, nodeId)) !== launchId) {
        reply(res, 204);
        return;
      }
      // A chat session reports through its host; its agent's own hooks would say it twice.
      if (scheduler.isChat(sessionIdOf(runId, nodeId))) {
        reply(res, 204);
        return;
      }
      // What the hook saw goes on the session's timeline (reviewers and partners too).
      // A session whose JSON stream Rivet reads gets only prompts from its hooks.
      const entries = checkEntries(payload.timeline)
        .filter((e) => e.kind === "prompt" || !scheduler.streamsTimeline(sessionIdOf(runId, nodeId)));
      if (entries.length) await write(() => store.addTimeline(runId, nodeId, entries)).catch(() => {});
      // A reviewer's or partner's activity is not the run's session state.
      if (nodeId === "review" || nodeId === "partner") {
        reply(res, 204);
        return;
      }
      if (payload.state !== undefined && !ACTIVITY_STATES.includes(payload.state as ActivityState)) {
        throw new HttpError(400, "invalid activity state");
      }
      const state = (payload.state as ActivityState | undefined) ?? null;
      const agentOwnId = optionalString(payload.agentOwnId, "agentOwnId");
      if (state === null && agentOwnId === undefined) {
        if (entries.length) {
          reply(res, 204);
          return;
        }
        throw new HttpError(400, "state or agentOwnId is required");
      }
      const before = state === "approval" ? await write(() => store.loadRun(runId).node.activity).catch(() => undefined) : undefined;
      const found = await write(() => store.recordSignal(runId, nodeId, state, agentOwnId));
      if (!found) throw new HttpError(404, "unknown session");
      // What a permission question asks, when the hook says; forgotten once the agent moves on.
      if (state === "approval") {
        const request = payload.request as { tool?: unknown; detail?: unknown } | undefined;
        if (request && typeof request.tool === "string") {
          scheduler.setPending(runId, { tool: request.tool.slice(0, 100), detail: typeof request.detail === "string" ? request.detail.slice(0, 500) : "" });
        }
      } else if (state !== null) scheduler.setPending(runId, null);
      if (state === "approval" && before !== "approval") void scheduler.onBlocked(runId).catch((e) => opts.onError?.(e));
      if (payload.turnEnded === true && state === "idle" && launchId !== undefined) {
        reply(res, 204);
        void scheduler.terminalTurnEnded(runId, launchId).then(() => {
          if (runtime.isAlive(sessionIdOf(runId, nodeId))) return scheduler.deliver(runId);
        }).catch((e) => opts.onError?.(e));
        return;
      }
      // An agent that went idle can take what was queued for it.
      if (state === "idle" || state === "asking") void scheduler.deliver(runId).catch((e) => opts.onError?.(e));
      reply(res, 204);
      return;
    }
    if (path === "/api/v1/doctor") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const { doctor, realProbes } = await import("../cli/doctor.js");
      const { loadPty } = await import("../runtime/runtime.js");
      const repoDir = new URL(req.url!, "http://x").searchParams.get("repo");
      const remote = repoDir ? (await git(["remote", "get-url", "origin"], repoDir).catch(() => "")).trim() : "";
      reply(res, 200, { checks: await doctor(data, realProbes({
        findClaude: () => findClaude(), findCodex: () => findCodex(), loadPty: () => loadPty() !== null,
        daemonUp: async () => true, githubToken: () => githubToken(process.env, remote),
      })) });
      return;
    }
    // Delta keeps its own provider keys (its config file, owner-only); Rivet only hands a
    // key over through the environment, so it is never on a command line, stored or logged.
    if (path === "/api/v1/delta" || path === "/api/v1/delta/key") {
      const q = new URL(req.url!, "http://x").searchParams;
      const payload = req.method === "POST" ? await body(req) : {};
      const project = optionalString(payload.project ?? q.get("project") ?? undefined, "project") ?? "";
      const binary = (project && (await write(() => store.getConfig(project)))["delta.binary"]?.trim()) || "delta";
      const { execFile } = await import("node:child_process");
      const run = (args: string[], env: Record<string, string> = {}, input?: string) => new Promise<{ code: number; out: string }>((resolve) => {
        // Delta writes run logs where it starts unless told otherwise; not in whatever folder the daemon runs from.
        const child = execFile(binary, args, { cwd: data, env: { ...process.env, DELTA_LOG_DIR: join(data, "logs", "delta", "daemon"), ...env }, timeout: 60_000, windowsHide: true, shell: /\.(cmd|bat)$/i.test(binary) }, (error, stdout, stderr) =>
          resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: `${stdout}${stderr}` }));
        child.stdin?.end(input ?? "");
      });
      if (path === "/api/v1/delta/key") {
        if (req.method !== "POST") throw new HttpError(405, "method not allowed");
        const provider = optionalString(payload.provider, "provider") ?? "";
        const key = typeof payload.key === "string" ? payload.key.trim() : "";
        if (!/^[a-z0-9_-]{1,40}$/.test(provider)) throw new HttpError(400, "provider must be one of delta's provider names");
        if (!key || key.length > 1000 || /\s/.test(key)) throw new HttpError(400, "key must be one line of text");
        const r = await run(["config", "--provider", provider], { DELTA_API_KEY: key });
        const said = r.out.split(key).join("[key]").trim().split("\n").slice(-3).join("\n");
        if (r.code !== 0) throw new HttpError(409, said || `delta config failed (${r.code})`);
        reply(res, 200, { saved: provider });
        return;
      }
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      // Its provider names come from its own refusal of an unknown one.
      const list = await run(["config", "--provider=unknown", "--model=unknown"]);
      const providers = /Choose one of: (.+)/.exec(list.out)?.[1]?.split(",").map((p) => p.trim()).filter(Boolean) ?? [];
      const models = await run(["--mode", "rpc", "--no-session"], {}, `${JSON.stringify({ id: "m", type: "get_available_models" })}\n${JSON.stringify({ id: "s", type: "shutdown" })}\n`);
      const found = models.out.split("\n").map((l) => { try { return JSON.parse(l) as { id?: string; data?: { models?: { provider: string; id: string }[] } }; } catch { return null; } })
        .find((r) => r?.id === "m")?.data?.models ?? [];
      if (!providers.length && !found.length) throw new HttpError(409, `cannot run delta (${binary}): set delta.binary to a delta with --mode rpc`);
      reply(res, 200, { providers, models: found.map((m) => ({ provider: m.provider, id: m.id })) });
      return;
    }
    if (path === "/api/v1/tasks/parse") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const payload = await body(req);
      if (typeof payload.source !== "string") throw new HttpError(400, "source must be a string");
      try { reply(res, 200, { tasks: parseTaskFile(payload.source, optionalString(payload.fileName, "fileName") ?? "tasks.yaml") }); }
      catch (e) { if (e instanceof TaskFileError) throw new HttpError(400, e.message); throw e; }
      return;
    }
    const diffRoute = /^\/api\/v1\/runs\/([^/]+)\/diff$/.exec(path);
    if (diffRoute) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const run = await write(() => store.loadRun(diffRoute[1]!)).catch(() => null);
      if (!run) throw new HttpError(404, "unknown run");
      if (!existsSync(run.node.worktree)) { reply(res, 200, { available: false, diff: "", stat: "", untracked: [], cut: false, untrusted: true }); return; }
      // Everything this worktree changed from where it branched, committed or not.
      const from = (await git(["merge-base", run.base, "HEAD"], run.node.worktree).catch(() => run.base)).trim();
      const [full, stat, untracked] = await Promise.all([
        git(["diff", from], run.node.worktree), git(["diff", "--stat", from], run.node.worktree),
        git(["ls-files", "--others", "--exclude-standard"], run.node.worktree),
      ]);
      const cut = full.length > DIFF_LIMIT;
      reply(res, 200, { available: true, diff: cut ? full.slice(0, DIFF_LIMIT) : full, stat, untracked: untracked.split(/\r?\n/).filter(Boolean), cut, untrusted: true });
      return;
    }
    if (path === "/api/v1/recovery") {
      if (req.method !== "GET") throw new HttpError(405,"method not allowed");
      reply(res,200,await write(()=>({...store.recoveryStatus(),integrity:store.verifyJournal()})));return;
    }
    if (path === "/api/v1/threads") {
      if(req.method!=="GET")throw new HttpError(405,"method not allowed");
      const q=new URL(req.url!,"http://x").searchParams;const mode=q.get("archived")??"hide";
      const limit=Number(q.get("limit")??50);if(!["hide","only","all"].includes(mode)||!Number.isInteger(limit)||limit<1||limit>100)throw new HttpError(400,"invalid thread filter or limit");
      const rows=await write(()=>store.listRuns(q.get("project")??undefined).map(id=>({run:store.loadRun(id),organization:store.organization(id)})).filter(({run,organization:o})=>(mode==="all"||(mode==="only"?!!o.archivedAt:!o.archivedAt))&&(!q.has("group")||o.group===q.get("group"))&&(!q.has("after")||run.id>q.get("after")!)).sort((a,b)=>a.run.id.localeCompare(b.run.id)));
      reply(res,200,{untrusted:true,threads:rows.slice(0,limit),...(rows.length>limit?{next:rows[limit-1]!.run.id}:{})});return;
    }
    const organizationRoute=/^\/api\/v1\/runs\/([^/]+)\/organization$/.exec(path);
    if(organizationRoute){
      if(req.method!=="PATCH")throw new HttpError(405,"method not allowed");
      const payload=await body(req);const name=optionalString(payload.name,"name");const group=optionalString(payload.group,"group");
      const flag=(k:string)=>payload[k]!==undefined&&typeof payload[k]!=="boolean";
      const snooze=payload.snoozedUntil;const busy=payload.busy;
      if(name!==undefined&&(!name.trim()||name.length>100)||group!==undefined&&group.length>100||flag("archived")||flag("pinned")||flag("unread")
        ||snooze!==undefined&&snooze!==null&&(typeof snooze!=="string"||Number.isNaN(Date.parse(snooze)))||busy!==undefined&&busy!==null&&(typeof busy!=="string"||!busy.trim()||busy.length>200))throw new HttpError(400,"invalid organization fields");
      await write(()=>store.organizeRun(organizationRoute[1]!,{...(name!==undefined?{name:name.trim()}:{}),...(group!==undefined?{group}:{}),...(payload.archived!==undefined?{archived:payload.archived as boolean}:{}),
        ...(payload.pinned!==undefined?{pinned:payload.pinned as boolean}:{}),...(payload.unread!==undefined?{unread:payload.unread as boolean}:{}),
        ...(snooze!==undefined?{snoozedUntil:snooze===null?null:new Date(snooze as string).toISOString()}:{}),...(busy!==undefined?{busy:busy===null?null:(busy as string).trim()}:{})}));
      reply(res,200,await write(()=>({run:store.loadRun(organizationRoute[1]!),organization:store.organization(organizationRoute[1]!)})));return;
    }
    if(path==="/api/v1/recovery/snapshot"){
      if(req.method!=="POST")throw new HttpError(405,"method not allowed");const payload=await body(req);const path=optionalString(payload.path,"path");if(!path)throw new HttpError(400,"snapshot path required");
      reply(res,201,await write(()=>store.snapshot(path)));return;
    }
    if(path==="/api/v1/recovery/journal"){
      if(req.method!=="GET")throw new HttpError(405,"method not allowed");const q=new URL(req.url!,"http://x").searchParams;const after=Number(q.get("after")??0),limit=Number(q.get("limit")??50);
      if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>200)throw new HttpError(400,"invalid journal page");
      reply(res,200,await write(()=>store.journalEntries(after,limit)));return;
    }
    const chatRoute = /^\/api\/v1\/sessions\/([^/]+)\/chat$/.exec(path);
    if (chatRoute) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const { runId, nodeId } = session(chatRoute[1]);
      const payload = await body(req);
      const launchId = optionalString(payload.launchId, "launchId");
      if (launchId !== undefined && launches.get(sessionIdOf(runId, nodeId)) !== launchId) {
        reply(res, 204);
        return;
      }
      const batchId = optionalString(payload.batchId, "batchId");
      if (batchId && batchId.length > 128) throw new HttpError(400, "batchId is too long");
      const accepted = payload.accepted === undefined ? [] : payload.accepted;
      if (!Array.isArray(accepted) || accepted.length > 1000 || accepted.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new HttpError(400, "invalid accepted message IDs");
      const events = checkChatEvents(payload.events);
      if (nodeId === NODE_ID && launchId && launches.get(sessionIdOf(runId, nodeId)) === launchId) {
        let observed = subagents.get(runId);
        if (!observed || observed.launch !== launchId) { observed = { launch: launchId, children: new Map() }; subagents.set(runId, observed); }
        for (const event of events) {
          if (event.type !== "activity" || !event.itemId?.startsWith("child-")) continue;
          const id = event.itemId.slice(6);
          if (!id || id.length > 256) continue;
          observed.children.set(id, { id, label: event.summary, status: event.status, canCancel: event.status === "working" && event.summary.includes("stop available") });
        }
      }
      const outcome = await write(() => store.recordChat(runId, nodeId, events, batchId ? { id: batchId, accepted: accepted as number[] } : undefined));
      // A finished turn is something new to read.
      if (nodeId === NODE_ID && payload.replay !== true && events.some((e) => e.type === "turn" && e.state !== "working")) await write(() => store.organizeRun(runId, { unread: true })).catch(() => {});
      const raw = Array.isArray(payload.raw) ? (payload.raw as unknown[]).filter((l): l is string => typeof l === "string").slice(0, 2000).map((l) => l.slice(0, 64 * 1024)) : [];
      if (raw.length) await write(() => store.recordProviderLines(runId, nodeId, raw));
      if (payload.replay === true) {
        reply(res, 204);
        return;
      }
      if (nodeId === NODE_ID && (payload.events as { type?: string; state?: string }[] | undefined)?.some((e) => e?.type === "turn" && e.state === "failed")) {
        void scheduler.chatTurnFailed(runId).catch((e) => opts.onError?.(e));
      }
      const state = outcome.activity ?? null;
      if (nodeId === "review" || nodeId === "partner" || state === null) {
        reply(res, 204);
        return;
      }
      const before = state === "approval" ? await write(() => store.loadRun(runId).node.activity).catch(() => undefined) : undefined;
      await write(() => store.recordSignal(runId, nodeId, state));
      if (outcome.question) scheduler.setPending(runId, { tool: outcome.question.tool.slice(0, 100), detail: outcome.question.detail.slice(0, 500) });
      else if (state !== "approval") scheduler.setPending(runId, null);
      if (state === "approval" && before !== "approval") void scheduler.onBlocked(runId).catch((e) => opts.onError?.(e));
      if (state === "idle") void scheduler.deliver(runId).catch((e) => opts.onError?.(e));
      reply(res, 204);
      return;
    }
    if (path === "/api/v1/outcomes") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const payload = await body(req);
      const { runId, nodeId } = session(payload.sessionId);
      if (!REPORT_KINDS.includes(payload.kind as ReportKind)) throw new HttpError(400, "invalid report kind");
      const message = optionalString(payload.message, "message");
      // A partner's report is its result for the worker that delegated to it.
      if (nodeId === "partner") {
        scheduler.partnerReport(runId, payload.kind as string, message);
        reply(res, 201, { id: 0 });
        return;
      }
      const id = await write(() => store.recordOutcome(runId, nodeId, payload.kind as ReportKind, message));
      if (id === null) throw new HttpError(404, "unknown session");
      await write(() => store.organizeRun(runId, { unread: true })).catch(() => {});
      void scheduler.onReport(runId, payload.kind as string, message).catch((e) => opts.onError?.(e));
      reply(res, 201, { id });
      return;
    }
    const commit = /^\/api\/v1\/sessions\/([^/]+)\/commit$/.exec(path);
    if (commit) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const { runId, nodeId } = session(commit[1]);
      const { message, launchId } = await body(req);
      if (nodeId !== NODE_ID || typeof launchId !== "string") throw new HttpError(403, "a worker launch is required");
      if (typeof message !== "string" || !message.trim() || message.length > 200 || /[\r\n\0]/.test(message)) throw new HttpError(400, "provide a single-line commit message of at most 200 characters");
      reply(res, 200, await scheduler.commitWorker(runId, launchId, message.trim()));
      return;
    }
    const delegation = /^\/api\/v1\/sessions\/([^/]+)\/delegate$/.exec(path);
    if (delegation) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const { runId, nodeId } = session(delegation[1]);
      if (nodeId !== NODE_ID) throw new HttpError(409, "only a worker delegates");
      const payload = await body(req);
      const agent = optionalString(payload.agent, "agent");
      if (agent !== undefined && !AGENTS.includes(agent as never)) throw new HttpError(400, `agent must be one of ${AGENTS.join(", ")}`);
      const model = optionalString(payload.model, "model");
      reply(res, 202, await scheduler.delegate(runId, {
        task: optionalString(payload.task, "task") ?? "", review: payload.review === true,
        ...(agent ? { agent: agent as never } : {}), ...(model ? { model } : {}),
      }));
      return;
    }
    const submit = /^\/api\/v1\/sessions\/([^/]+)\/review$/.exec(path);
    if (submit) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const { runId, nodeId } = session(submit[1]);
      if (nodeId !== "review") throw new HttpError(409, "only a reviewer submits a review");
      const payload = await body(req);
      if (payload.verdict !== "approved" && payload.verdict !== "changes_requested") throw new HttpError(400, "verdict must be approved or changes_requested");
      if (typeof payload.summary !== "string" || !payload.summary.trim()) throw new HttpError(400, "summary is required");
      const comments = (Array.isArray(payload.comments) ? payload.comments : []) as { path: string; line: number; body: string }[];
      for (const c of comments) {
        if (typeof c?.path !== "string" || !Number.isInteger(c?.line) || c.line < 1 || typeof c?.body !== "string") throw new HttpError(400, "each comment needs path, line and body");
      }
      reply(res, 200, await scheduler.submitReview(runId, { verdict: payload.verdict, summary: payload.summary.trim(), comments }));
      return;
    }
    const check = /^\/api\/v1\/sessions\/([^/]+)\/check$/.exec(path);
    if (check) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const { runId } = session(check[1]);
      reply(res, 200, await scheduler.agentCheck(runId));
      return;
    }
    // An agent's request for a secret waits here until the person answers it in the app.
    const secretAsk = /^\/api\/v1\/sessions\/([^/]+)\/secret$/.exec(path);
    if (secretAsk) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const sessionId = secretAsk[1]!;
      const { runId, nodeId } = session(sessionId);
      const payload = await body(req);
      const name = optionalString(payload.name, "name")?.trim() ?? "";
      const why = optionalString(payload.why, "why")?.trim() ?? "";
      if (!name || name.length > 100 || why.length > 500) throw new HttpError(400, "name (at most 100 characters) and why (at most 500) are required");
      let wait;
      try { wait = secrets.ask(sessionId, name, why); } catch (e) { throw new HttpError(409, (e as Error).message); }
      await write(() => store.addTimeline(runId, nodeId, [{ kind: "event", text: `asked for a secret: ${name}` }])).catch(() => {});
      await write(() => store.organizeRun(runId, { unread: true })).catch(() => {});
      const r = await wait;
      await write(() => store.addTimeline(runId, nodeId, [{ kind: "event", text: r.path ? `secret ${name} given as a file` : r.refused ? `secret ${name} refused` : `secret ${name} not answered in time` }])).catch(() => {});
      reply(res, 200, r.path ? { path: r.path, note: "Read the file where a command needs the value. Never print, log or commit it; it is deleted when this session ends." } : { refused: true, ...(r.expired ? { expired: true } : {}) });
      return;
    }
    const secretAnswer = /^\/api\/v1\/runs\/([^/]+)\/secret$/.exec(path);
    if (secretAnswer) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const payload = await body(req);
      const id = optionalString(payload.id, "id") ?? "";
      if (payload.vault !== undefined) {
        const pending = secrets.pending(sessionIdOf(secretAnswer[1]!, NODE_ID));
        if (!pending || pending.id !== id) throw new HttpError(409, "that request is no longer waiting");
        const reference = payload.vault as Record<string, unknown>;
        if (!reference || typeof reference.provider !== "string" || typeof reference.account !== "string" || typeof reference.reference !== "string") throw new HttpError(400, "invalid vault reference");
        if (payload.refresh === true) vault.invalidate();
        let value: string;
        try { value = await vault.read({ provider: reference.provider, account: reference.account, reference: reference.reference }); }
        catch { throw new HttpError(409, "Vault read failed. Check the local vault CLI authentication, account and reference."); }
        if (!(await secrets.answer(sessionIdOf(secretAnswer[1]!, NODE_ID), id, value))) throw new HttpError(409, "that request is no longer waiting");
        reply(res, 204);
        return;
      }
      const value = payload.refuse === true ? null : typeof payload.value === "string" && payload.value.length > 0 && payload.value.length <= 20_000 ? payload.value : undefined;
      if (value === undefined) throw new HttpError(400, "value must be text of at most 20000 characters, or refuse must be true");
      if (!(await secrets.answer(sessionIdOf(secretAnswer[1]!, NODE_ID), id, value))) throw new HttpError(409, "that request is no longer waiting");
      reply(res, 204);
      return;
    }
    // Messages still waiting in Rivet for a session: listed, changed or withdrawn before they go out.
    const queued = /^\/api\/v1\/sessions\/([^/]+)\/queue(?:\/(\d+))?$/.exec(path);
    if (queued) {
      const { runId, nodeId } = session(queued[1]!);
      const id = queued[2] ? Number(queued[2]) : undefined;
      if (id === undefined) {
        if (req.method !== "GET") throw new HttpError(405, "method not allowed");
        reply(res, 200, { untrusted: true, messages: await write(() => store.undeliveredMessages(runId, nodeId)) });
        return;
      }
      if (req.method === "PATCH") {
        const payload = await body(req);
        if (payload.mode === "steer") {
          if (nodeId !== NODE_ID || !runtime.takesInput(sessionIdOf(runId, nodeId))) throw new HttpError(409, "this session cannot accept steering");
          if (branchChanges.has(runId)) throw new HttpError(409, "conversation branch is changing");
          if (!(await write(() => store.promoteQueued(runId, nodeId, id)))) throw new HttpError(409, "that message has already gone out");
          await scheduler.deliver(runId, id);
          reply(res, 200, { id, mode: "steer" });
          return;
        }
        const message = payload.message;
        if (typeof message !== "string" || !message.trim() || message.length > 100_000) throw new HttpError(400, "message must be text of at most 100000 characters");
        if (!(await write(() => store.editQueued(runId, nodeId, id, message)))) throw new HttpError(409, "that message is no longer waiting");
        reply(res, 200, { id });
        return;
      }
      if (req.method === "DELETE") {
        let removed: boolean;
        try { removed = await write(() => store.cancelQueued(runId, nodeId, id)); } catch (e) { throw new HttpError(409, (e as Error).message); }
        if (!removed) throw new HttpError(409, "that message is no longer waiting");
        reply(res, 204);
        return;
      }
      throw new HttpError(405, "method not allowed");
    }
    const send = /^\/api\/v1\/sessions\/([^/]+)\/send$/.exec(path);
    if (send) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const { runId, nodeId } = session(send[1]);
      if (branchChanges.has(runId)) throw new HttpError(409,"conversation branch is changing");
      const payload = await body(req);
      if (typeof payload.message !== "string") throw new HttpError(400, "message must be a string");
      const from = optionalString(payload.from, "from");
      const mode = (optionalString(payload.mode, "mode") ?? "steer") as SendMode;
      if (!SEND_MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${SEND_MODES.join(", ")}`);
      if ((await write(() => store.getFork(runId)))?.detached) throw new HttpError(409, "fork was detached from its shared checkout");
      const id = await write(() => {
        if (branchChanges.has(runId)) throw new HttpError(409, "conversation branch is changing");
        if (payload.attachments === undefined) return store.queueMessage(runId, nodeId, payload.message as string, from, mode);
        if (nodeId !== NODE_ID) throw new HttpError(400, "attachments require a thread session");
        store.loadRun(runId);
        let saved;
        try { saved = saveAttachments(data, runId, payload.attachments); }
        catch (error) { throw new HttpError(400, (error as Error).message); }
        try {
          const queued = store.queueMessage(runId, nodeId, String(payload.message) + saved.context, from, mode);
          if (queued === null) saved.remove();
          return queued;
        } catch (error) { saved.remove(); throw error; }
      });
      if (id === null) throw new HttpError(404, "unknown session");
      if (nodeId === NODE_ID) await scheduler.startForkMessage(runId);
      const target = sessionIdOf(runId, nodeId);
      let delivery: string;
      if (runtime.takesInput(target)) {
        await scheduler.deliver(runId);
        const left = await write(() => store.undeliveredMessages(runId, nodeId).some((m) => m.id === id));
        const activity = await write(() => store.loadRun(runId).node.activity);
        delivery = !left ? (mode === "interrupt" ? "interrupted" : "now") : activity === "approval" ? "after-answer" : "when-idle";
      } else if (runtime.isAlive(target)) {
        delivery = mode === "interrupt" && (await scheduler.interruptHeadless(runId)) ? "interrupted" : "turn-end";
      } else delivery = "next-launch";
      reply(res, 202, { id, delivery });
      return;
    }
    if (path === "/api/v1/search") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const q = new URL(req.url!, "http://x").searchParams;
      const query = q.get("query")?.trim();
      let page;
      try {
        page = await write(() => searchPage(store, query ?? "", {
          ...(q.has("limit") ? { limit: Number(q.get("limit")) } : {}),
          ...(q.has("cursor") ? { cursor: q.get("cursor")! } : {}),
          ...(q.get("project") ? { project: q.get("project")! } : {}),
        }));
      } catch (e) { if (e instanceof SearchInputError) throw new HttpError(400, e.message); throw e; }
      reply(res, 200, page);
      return;
    }
    const transferStatus = /^\/api\/v1\/runs\/([^/]+)\/transfers$/.exec(path);
    if (transferStatus) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      reply(res, 200, await write(() => { store.loadRun(transferStatus[1]!); return { transfers: store.listContextTransfers(transferStatus[1]!) }; }));
      return;
    }
    const discoveryRoute=/^\/api\/v1\/runs\/([^/]+)\/provider$/.exec(path);
    if(discoveryRoute){
      if(req.method!=="GET")throw new HttpError(405,"method not allowed");
      const run=await write(()=>store.loadRun(discoveryRoute[1]!));
      if(run.node.agent!=="claude"&&run.node.agent!=="codex")throw new HttpError(409,"provider discovery is unavailable");
      const {inspectProvider}=await import("../chat/discovery.js");reply(res,200,await inspectProvider(run.node.agent,run.repo));return;
    }
    if (path === "/api/v1/environment-preferences") {
      if (req.method === "GET") {
        reply(res, 200, { instructions: await write(() => store.environmentInstructions()), untrusted: true });
        return;
      }
      if (req.method === "PUT") {
        const instructions = (await body(req)).instructions;
        if (typeof instructions !== "string" || instructions.length > 8000) throw new HttpError(400, "instructions must have at most 8000 characters");
        await write(() => store.setEnvironmentInstructions(instructions));
        reply(res, 204);
        return;
      }
      throw new HttpError(405, "method not allowed");
    }
    const projects = /^\/api\/v1\/projects(?:\/([^/]+))?$/.exec(path);
    if (projects) {
      const id = projects[1];
      if (!id && req.method === "GET") {
        const after = new URL(req.url!, "http://local").searchParams.get("after") ?? "";
        const result = await write(() => store.listProjects().filter(key => key > after).slice(0, 51));
        const records = await write(() => result.slice(0, 50).map(key => store.projectMetadata(key)));
        reply(res, 200, { projects: records, next: result.length > 50 ? result[49] : null, untrusted: true });
        return;
      }
      if (id && req.method === "GET") {
        const project = await write(() => store.projectMetadata(id));
        if (!project) throw new HttpError(404, "unknown project");
        reply(res, 200, { project, untrusted: true });
        return;
      }
      if (id && req.method === "DELETE") {
        if ((await body(req)).confirm !== id) throw new HttpError(400, "confirm must match the project ID");
        try {
          await write(() => {
            if (runtime.liveSessions().some(sessionId => {
              const { runId } = session(sessionId);
              return store.loadRun(runId).project === id;
            })) throw new Error("stop the project's sessions first");
            store.deleteProject(id);
          });
        } catch (e) { throw new HttpError(409, (e as Error).message); }
        reply(res, 204);
        return;
      }
      if ((!id && req.method === "POST") || (id && req.method === "PATCH")) {
        const payload = await body(req);
        const repo = !id && typeof payload.repo === "string" ? await repoRoot(payload.repo).catch(() => null) : null;
        if (!id && !repo) throw new HttpError(400, "an existing Git repository is required");
        const key = id ?? defaultProjectId(repo!);
        const title = payload.title;
        const instructions = payload.instructions;
        const scripts = payload.scripts;
        if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 100)) throw new HttpError(400, "title must have 1–100 characters");
        if (instructions !== undefined && (typeof instructions !== "string" || instructions.length > 8000)) throw new HttpError(400, "instructions must have at most 8000 characters");
        if (scripts !== undefined && (!Array.isArray(scripts) || scripts.length > 30 || scripts.some(script => !script || typeof script.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(script.id) || typeof script.command !== "string" || !script.command.trim() || script.command.length > 1000) || new Set(scripts.map(script => script.id)).size !== scripts.length)) throw new HttpError(400, "provide at most 30 saved scripts with unique lowercase IDs and bounded commands");
        const project = await write(() => {
          const current = store.projectMetadata(key);
          if (id && !current) throw new HttpError(404, "unknown project");
          if (repo && current && current.repo !== repo) throw new HttpError(409, "project ID belongs to a different repository");
          const value = { id: key, repo: repo ?? current!.repo, title: (title as string | undefined) ?? current?.title ?? key,
            instructions: (instructions as string | undefined) ?? current?.instructions ?? "", scripts: (scripts as { id: string; command: string }[] | undefined)?.map(({ id, command }) => ({ id, command })) ?? current?.scripts ?? [] };
          store.saveProject(value);
          return value;
        });
        reply(res, id ? 200 : 201, { project, untrusted: true });
        return;
      }
      throw new HttpError(405, "method not allowed");
    }
    if (path === "/api/v1/attachments/preview") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      try { reply(res, 200, { ...await extractDocument(await body(req)), untrusted: true }); }
      catch (error) { throw new HttpError(400, (error as Error).message); }
      return;
    }
    const workspaceRoute = /^\/api\/v1\/runs\/([^/]+)\/(files|file|shell)$/.exec(path);
    if (workspaceRoute) {
      const run = await write(() => store.loadRun(workspaceRoute[1]!));
      const action = workspaceRoute[2];
      const query = new URL(req.url!, "http://local").searchParams;
      const selected = query.get("path") ?? "";
      try {
        if (action === "files" && req.method === "GET") {
          reply(res, 200, { ...await listFiles(run.node.worktree, selected, query.get("after") ?? ""), untrusted: true });
          return;
        }
        if (action === "file" && req.method === "GET") {
          reply(res, 200, { ...await readTextFile(run.node.worktree, selected), untrusted: true });
          return;
        }
        if (action === "file" && req.method === "PUT") {
          const input = await body(req);
          if (typeof input.text !== "string" || (input.version !== null && typeof input.version !== "string")) throw new HttpError(400, "text and the expected version are required");
          if (branchChanges.has(run.id) || scheduler.isCleaning(run.node.worktree)) throw new HttpError(409, "workspace is changing");
          if (run.spec?.paths?.length && outsidePaths([selected.replaceAll("\\", "/")], run.spec.paths).length) throw new HttpError(403, "file is outside this task's allowed paths");
          reply(res, 200, await saveTextFile(run.node.worktree, selected, input.text, input.version as string | null));
          return;
        }
        if (action === "shell") {
          const shellSession = run.id + "-shell";
          if (req.method === "GET") { reply(res, 200, { alive: runtime.isAlive(shellSession) }); return; }
          if (req.method === "DELETE") { await runtime.stop(shellSession); reply(res, 204); return; }
          if (req.method === "POST") {
            if (branchChanges.has(run.id) || scheduler.isCleaning(run.node.worktree)) throw new HttpError(409, "workspace is changing");
            const key = run.id + ":shell";
            if (scriptRuns.get(key)?.starting || runtime.isAlive(shellSession)) throw new HttpError(409, "workspace shell is already running");
            const entry = { session: shellSession, script: "workspace shell", worktree: run.node.worktree, starting: true };
            scriptRuns.set(key, entry);
            try {
              const argv = process.platform === "win32" ? [process.env.ComSpec ?? "cmd.exe", "/d", "/q"] : [process.env.SHELL ?? "/bin/sh", "-i"];
              await runtime.start({ sessionId: shellSession, workspace: run.node.worktree, argv, env: { RIVET_SESSION_ID: shellSession }, terminal: { cols: 100, rows: 28 } });
              entry.starting = false;
            } catch (error) { scriptRuns.delete(key); throw error; }
            await write(() => store.addTimeline(run.id, NODE_ID, [{ kind: "event", text: "Opened workspace shell" }]));
            reply(res, 201, { session: shellSession });
            return;
          }
        }
      } catch (error) {
        if (error instanceof WorkspaceError) throw new HttpError(error.status, error.message);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new HttpError(404,"workspace path no longer exists");
        if (code === "EACCES" || code === "EPERM") throw new HttpError(403,"workspace path is not accessible");
        if (code === "ENOTDIR" || code === "EISDIR") throw new HttpError(400,"choose the correct file or directory type");
        throw error;
      }
      throw new HttpError(405, "method not allowed");
    }
    const scriptRoute = /^\/api\/v1\/runs\/([^/]+)\/scripts(?:\/([^/]+))?$/.exec(path);
    if (scriptRoute) {
      const run = await write(() => store.loadRun(scriptRoute[1]!));
      const project = await write(() => store.projectMetadata(run.project));
      const scripts = project?.scripts ?? [];
      const current = scriptRuns.get(run.id);
      if (req.method === "GET" && !scriptRoute[2]) {
        const output = current ? runtime.output(current.session, 100) : null;
        reply(res, 200, { scripts, running: current ? { id: current.script, alive: runtime.isAlive(current.session), exitCode: output?.exitCode ?? null, output: redact(output?.lines.join("\n") ?? "") } : null, untrusted: true });
        return;
      }
      if (req.method === "DELETE" && !scriptRoute[2]) {
        if (current) await runtime.stop(current.session);
        reply(res, 204);
        return;
      }
      if (req.method !== "POST" || !scriptRoute[2]) throw new HttpError(405, "method not allowed");
      const script = scripts.find(candidate => candidate.id === scriptRoute[2]);
      if (!script) throw new HttpError(404, "saved script not found");
      if ((await body(req)).confirm !== script.id) throw new HttpError(400, "confirm must match the script ID");
      if (current && (current.starting || runtime.isAlive(current.session))) throw new HttpError(409, "stop the current script first");
      if (branchChanges.has(run.id) || scheduler.isCleaning(run.node.worktree)) throw new HttpError(409, "workspace is changing");
      const session = run.id + "-script";
      const launcher = "const {spawn}=require('node:child_process');const child=spawn(process.argv[1],{shell:true,stdio:'inherit',windowsHide:true});child.on('error',error=>{console.error(error.message);process.exitCode=1});child.on('exit',code=>{process.exitCode=code??1});";
      const execution = { session, script: script.id, worktree: run.node.worktree, starting: true };
      scriptRuns.set(run.id, execution);
      try {
        await runtime.start({ sessionId: session, workspace: run.node.worktree, argv: [process.execPath, "-e", launcher, script.command], env: {} });
        execution.starting = false;
      } catch (error) {
        scriptRuns.delete(run.id);
        throw error;
      }
      await write(() => store.addTimeline(run.id, NODE_ID, [{ kind: "event", text: "Started saved script " + script.id }]));
      reply(res, 202, { id: script.id });
      return;
    }
    const prLinks = /^\/api\/v1\/runs\/([^/]+)\/linked-prs(?:\/(\d+))?$/.exec(path);
    if (prLinks) {
      const id = prLinks[1]!;
      await write(() => store.loadRun(id));
      if (req.method === "GET" && !prLinks[2]) {
        reply(res, 200, await write(() => ({ primary: store.getPr(id), linked: store.linkedPrs(id) })));
        return;
      }
      if (req.method === "POST" && !prLinks[2]) {
        const number = (await body(req)).number;
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new HttpError(400, "invalid pull request number");
        reply(res, 200, await scheduler.addPrLink(id, number));
        return;
      }
      if (req.method === "DELETE" && prLinks[2]) {
        const number = Number(prLinks[2]);
        if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(400, "invalid pull request number");
        if (!(await write(() => store.removeLinkedPr(id, number)))) throw new HttpError(404, "pull request link not found");
        reply(res, 204);
        return;
      }
      throw new HttpError(405, "method not allowed");
    }
    const prGuides = /^\/api\/v1\/runs\/([^/]+)\/pr-guides(?:\/(\d+))?$/.exec(path);
    if (prGuides) {
      const id = prGuides[1]!;
      await write(() => store.loadRun(id));
      if (req.method === "GET" && prGuides[2]) {
        const number = Number(prGuides[2]);
        if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(400, "invalid pull request number");
        const text = await write(() => store.readPrGuide(id, number));
        if (text === null) throw new HttpError(404, "guide not found");
        reply(res, 200, { number, text, untrusted: true });
        return;
      }
      if (req.method === "PUT" && !prGuides[2]) {
        const guides = (await body(req)).guides;
        if (!Array.isArray(guides) || guides.length < 1 || guides.length > 10) throw new HttpError(400, "provide 1–10 pull request guides");
        const numbers = new Set<number>();
        for (const guide of guides) {
          if (!guide || !Number.isSafeInteger(guide.number) || guide.number < 1 || numbers.has(guide.number) || typeof guide.text !== "string" || !guide.text.trim() || guide.text.length > 16000) throw new HttpError(400, "each guide needs a unique positive PR number and 1–16000 characters of text");
          numbers.add(guide.number);
        }
        await write(() => store.writePrGuides(id, guides));
        reply(res, 200, { saved: [...numbers] });
        return;
      }
      throw new HttpError(405, "method not allowed");
    }
    const childStop = /^\/api\/v1\/runs\/([^/]+)\/stop-subagent$/.exec(path);
    if (childStop) {
      const run = await write(() => store.loadRun(childStop[1]!));
      const observed = subagents.get(run.id);
      const current = observed?.launch === launches.get(sessionIdOf(run.id, NODE_ID)) && runtime.isAlive(sessionIdOf(run.id, NODE_ID));
      if (req.method === "GET") {
        reply(res, 200, { children: current ? [...observed!.children.values()] : [], untrusted: true });
        return;
      }
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const target = sessionIdOf(run.id, NODE_ID);
      if (run.node.agent !== "claude" || !scheduler.isChat(target) || !runtime.isAlive(target)) throw new HttpError(409, "a live Claude chat is required");
      const id = (await body(req)).id;
      if (typeof id !== "string" || !id.trim() || id.length > 256) throw new HttpError(400, "a sub-agent session ID is required");
      if (!current || !observed?.children.get(id)?.canCancel) throw new HttpError(409, "this child has no active stop capability");
      await runtime.write(target, JSON.stringify({ type: "stop-child", id }));
      reply(res, 202, { requested: true });
      return;
    }
    const compactRoute=/^\/api\/v1\/runs\/([^/]+)\/compact$/.exec(path);
    if(compactRoute){
      if(req.method!=="POST")throw new HttpError(405,"method not allowed");
      const run=await write(()=>store.loadRun(compactRoute[1]!));
      if(!["claude","codex"].includes(run.node.agent)||run.node.runMode!=="chat")throw new HttpError(409,"native compaction requires a supported chat provider");
      const pending=await write(()=>store.pendingContextSize(run.id)>0||store.undeliveredMessages(run.id,NODE_ID).length>0||store.listRuns().some(id=>{const child=store.loadRun(id);return child.orchestrator===sessionIdOf(run.id,NODE_ID)&&["pending","running"].includes(child.node.status);}));
      if(run.node.activity!=="idle"||pending||runtime.isAlive(sessionIdOf(run.id,"partner"))||runtime.isAlive(sessionIdOf(run.id,"review")))throw new HttpError(409,"compaction requires idle with no pending context, messages or child work");
      await runtime.write(sessionIdOf(run.id,NODE_ID),JSON.stringify({type:"compact"}));reply(res,202,{requested:true,runId:run.id});return;
    }
    const reconcileRoute = /^\/api\/v1\/runs\/([^/]+)\/reconcile$/.exec(path);
    if (reconcileRoute) {
      if (req.method !== "POST") throw new HttpError(405,"method not allowed");
      const run = await write(()=>store.loadRun(reconcileRoute[1]!));
      if (run.node.runMode !== "chat" || !["claude","codex"].includes(run.node.agent)) throw new HttpError(409,"provider history refresh requires a supported chat provider");
      if (run.node.activity !== "idle") throw new HttpError(409,"wait for idle before reconciliation");
      await runtime.write(sessionIdOf(run.id,NODE_ID),JSON.stringify({type:"reconcile"}));
      reply(res,202,{requested:true,runId:run.id});return;
    }
    const branchRoute = /^\/api\/v1\/runs\/([^/]+)\/(branches|rollback|edit)$/.exec(path);
    if (branchRoute) {
      const id = branchRoute[1]!;
      if (req.method === "GET" && branchRoute[2] === "branches") {
        reply(res,200,{untrusted:true,branches:await write(()=>store.branches(id))}); return;
      }
      if (req.method !== "POST") throw new HttpError(405,"method not allowed");
      const payload = await body(req);
      if (branchChanges.has(id)) throw new HttpError(409,"conversation branch is changing");
      branchChanges.add(id);
      try {
      const source = await write(()=>store.loadRun(id));
      if ((await write(()=>store.getFork(id)))?.detached) throw new HttpError(409,"fork is detached");
      if (source.node.runMode !== "chat") throw new HttpError(409,"conversation editing requires chat mode");
      if (["busy","approval"].includes(source.node.activity ?? "")) throw new HttpError(409,"wait for the active turn or answer its permission request first");
      if ((await write(()=>store.undeliveredMessages(id,NODE_ID))).length) throw new HttpError(409,"settle pending messages before changing conversation branches");
      const history = await write(()=>store.readChat(id,{limit:5001}).items);
      if (history.length > 5000) throw new HttpError(409,"conversation exceeds the branch snapshot limit");
      let prefix = history;
      let replacement: string | undefined;
      const restore = branchRoute[2] === "branches" ? optionalString(payload.branch,"branch") : undefined;
      if (branchRoute[2] === "rollback") {
        const turns = payload.turns;
        if (!Number.isSafeInteger(turns) || (turns as number) < 1) throw new HttpError(400,"turns must be a positive integer");
        const prompts = history.filter(i=>i.kind === "prompt" || i.kind === "message");
        const boundary = prompts.at(-(turns as number));
        if (!boundary) throw new HttpError(400,"not enough turns to roll back");
        prefix = history.filter(i=>i.position < boundary.position);
      } else if (branchRoute[2] === "edit") {
        const prompt = history.find(i=>i.position === payload.at && ["prompt","message"].includes(i.kind));
        replacement = optionalString(payload.message,"message");
        if (!prompt || !replacement) throw new HttpError(400,"edit needs a user-message position and replacement message");
        prefix = history.filter(i=>i.position < prompt.position);
      } else if (!restore) throw new HttpError(400,"branch is required");
      if (restore) {
        const target = await write(()=>store.branches(id).find(b=>b.id===restore));
        if (!target) throw new HttpError(404,"unknown conversation branch");
        if (target.active) {reply(res,200,{runId:id,branch:target.id,strategy:"unchanged"});return;}
        if (target.agent !== source.node.agent) throw new HttpError(409,"switch to the branch's provider before restoring it");
      }
      if (source.spec?.denyTools?.length) throw new HttpError(409,"this task's denyTools cannot be enforced in chat mode");
      await scheduler.stopSession(sessionIdOf(id,NODE_ID));
      const branch = await write(()=>store.changeBranch(id,prefix,history,restore));
      if (replacement) await write(()=>store.queueMessage(id,NODE_ID,replacement,undefined,"queue"));
      const fresh = await write(()=>store.loadRun(id));
      await scheduler.launch(fresh,undefined,fresh.node.agentChatId ? {resume:true} : {});
      reply(res,202,{runId:id,branch,strategy:restore ? "restore" : "pending",filesystem:"current checkout; historical files are not restored"}); return;
      } finally {branchChanges.delete(id);}
    }
    const createThreadsRoute = /^\/api\/v1\/runs\/([^/]+)\/threads$/.exec(path);
    if (createThreadsRoute) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const tasks = (await body(req)).tasks;
      if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task.task !== "string" || (task.name !== undefined && typeof task.name !== "string"))) throw new HttpError(400, "tasks must contain task text and optional names");
      const ids = await write(() => {
        const source = store.loadRun(createThreadsRoute[1]!);
        if (scheduler.isCleaning(source.node.worktree) || !existsSync(source.node.worktree)) throw new HttpError(409, "source checkout is missing or being cleaned");
        return store.createThreads(source.id, tasks);
      });
      reply(res, 201, { threads: ids.map(runId => ({ runId, started: false })) });
      return;
    }
    const conversationRoute = /^\/api\/v1\/runs\/([^/]+)\/(fork|carry-back)$/.exec(path);
    if (conversationRoute) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const payload = await body(req);
      const at = payload.at;
      if (at !== undefined && (typeof at !== "number" || !Number.isSafeInteger(at) || at < 1)) throw new HttpError(400, "at must be a positive position");
      const name = optionalString(payload.name, "name");
      if (name && name.length > 100) throw new HttpError(400, "name must be at most 100 characters");
      const target = optionalString(payload.target, "target");
      try {
        if (conversationRoute[2] === "fork") reply(res, 201, await write(() => {
          const source = store.loadRun(conversationRoute[1]!);
          if (scheduler.isCleaning(source.node.worktree) || !existsSync(source.node.worktree)) throw new Error("source checkout is missing or being cleaned");
          return forkConversation(store, source.id, { at: at as number | undefined, name });
        }));
        else {
          const transfer = await write(() => mergeConversation(store, conversationRoute[1]!, target, at as number | undefined));
          reply(res, 202, transfer);
        }
      } catch (e) { throw new HttpError(409, (e as Error).message); }
      return;
    }
    const waitRoute = /^\/api\/v1\/runs\/([^/]+)\/wait$/.exec(path);
    if (waitRoute) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const runId = waitRoute[1]!;
      const q = new URL(req.url!, "http://x").searchParams;
      const scope = q.get("scope") ?? "turn";
      const timeoutMs = Number(q.get("timeoutMs") ?? 30000);
      if (!["turn", "task"].includes(scope) || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw new HttpError(400, "invalid wait scope or timeout (0-60000 ms)");
      if (!(await write(() => store.listRuns().includes(runId)))) throw new HttpError(404, "unknown run");
      const wakeSession = q.get("wakeSession");
      const wakeCaller = wakeSession ? session(wakeSession) : undefined;
      if (wakeCaller && (await write(() => store.loadRun(wakeCaller.runId).project !== store.loadRun(runId).project))) throw new HttpError(400, "wake target must be in the same project");
      if (wakeCaller?.runId === runId) throw new HttpError(400, "cannot wake a session waiting on itself");
      if (q.get("turn")) {
        try { await write(() => store.waitTurn(runId, q.get("turn")!)); } catch { throw new HttpError(404, "unknown turn"); }
      }
      const abort = new AbortController();
      const closed = () => abort.abort();
      res.on("close", closed);
      try {
        const result = await waitForRun(async (turn) => write(() => {
          const run = store.loadRun(runId);
          return { retrying: run.node.status === "failed" && run.node.attempts < (run.spec?.attempts ?? 2), status: run.node.status, activity: run.node.activity, live: runtime.isAlive(sessionIdOf(run.id, run.node.id)), turn: store.waitTurn(run.id, turn), pendingRequest: scheduler.pendingRequest(run.id), pending: runtime.isAlive(sessionIdOf(run.id, run.node.id)) && !run.node.firstSignalAt };
        }), { scope: scope as "turn" | "task", timeoutMs, ...(q.get("turn") ? { turn: q.get("turn")! } : {}) }, AbortSignal.any([abort.signal, waitAbort.signal]));
        let next: string | undefined;
        if (result.timedOut && wakeCaller) {
          await write(() => store.subscribeWait(runId,wakeCaller.runId,wakeCaller.nodeId,scope,result.turnId ?? ""));
          next = "Completion wakes this session, so end your turn. Do not poll.";
        }
        if (!abort.signal.aborted) reply(res, 200, { ...result, ...(next ? { next } : {}) });
      } catch (e) { if (waitAbort.signal.aborted && !abort.signal.aborted) reply(res, 503, { error: "daemon stopping" }); else if (!abort.signal.aborted) throw e; } finally { res.off("close", closed); }
      return;
    }
    const timelineRoute = /^\/api\/v1\/runs\/([^/]+)\/timeline$/.exec(path);
    if (timelineRoute) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const runId = timelineRoute[1]!;
      const run = await write(() => store.loadRun(runId)).catch(() => null);
      if (!run) throw new HttpError(404, "unknown run");
      const q = new URL(req.url ?? "", "http://x").searchParams;
      const num = (k: string, d: number, max: number) => Math.min(max, Math.max(1, Number(q.get(k) ?? d) || d));
      const item = q.has("item") ? Number(q.get("item")) : undefined;
      const textOffset = Number(q.get("textOffset") ?? 0);
      if (item !== undefined && (!Number.isSafeInteger(item) || item < 1) || !Number.isSafeInteger(textOffset) || textOffset < 0 || textOffset > 0 && item === undefined) throw new HttpError(400, "item must be a positive position; textOffset requires an item and must be nonnegative");
      const view = item !== undefined || q.get("view") === "activity" ? "activity" : "messages";
      const limit = num("limit", 50, 100);
      const maxChars = num("maxChars", 20_000, 50_000);
      const session = q.get("session") ?? undefined;
      // A chat session's conversation is its timeline.
      const chat = run.node.runMode === "chat" && (!session || session === NODE_ID);
      const page = await write(() => (chat ? store.readChat : store.readTimeline)(run.id, {
        after: item !== undefined ? item - 1 : Number(q.get("after") ?? 0) || 0, limit: item !== undefined ? 1 : limit, ...(view === "messages" ? { kinds: MESSAGE_KINDS } : {}), ...(session ? { session } : {}),
      }));
      if (item !== undefined && page.items[0]?.position !== item) throw new HttpError(404, "history item not found");
      if (item !== undefined && textOffset > page.items[0]!.text.length) throw new HttpError(400, "textOffset exceeds item length");
      const items = page.items.map((i) => {
        const offset = item !== undefined ? textOffset : 0;
        const end = Math.min(i.text.length, offset + maxChars);
        return {...i, text: i.text.slice(offset, end), textOffset: offset, nextTextOffset: end < i.text.length ? end : null,
          ...(end < i.text.length ? {cut:{shown:end-offset,length:i.text.length}} : {})};
      });
      const last = items.at(-1)?.position;
      reply(res, 200, {
        run: { id: run.id, name: run.name, role: run.role, agent: run.node.agent, status: run.node.status, activity: run.node.activity ?? null },
        view, total: page.total, items, ...(last !== undefined && page.items.length === limit ? { next: last } : {}),
      });
      return;
    }
    // A chat session's agent lines as they came, for looking into what Rivet made of them.
    const providerRoute = /^\/api\/v1\/runs\/([^/]+)\/provider-events$/.exec(path);
    if (providerRoute) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const runId = providerRoute[1]!;
      if (!(await write(() => store.loadRun(runId)).catch(() => null))) throw new HttpError(404, "unknown run");
      const q = new URL(req.url ?? "", "http://x").searchParams;
      const limit = Math.min(1000, Math.max(1, Number(q.get("limit") ?? 200) || 200));
      const lines = await write(() => store.providerLines(runId, { after: Number(q.get("after") ?? 0) || 0, limit, ...(q.get("session") ? { session: q.get("session")! } : {}) }));
      const last = lines.at(-1)?.position;
      reply(res, 200, { lines, ...(last !== undefined && lines.length === limit ? { next: last } : {}) });
      return;
    }
    const eventsRoute = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(path);
    if (eventsRoute) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const runId = eventsRoute[1]!;
      if (!(await write(() => store.loadRun(runId)).catch(() => null))) throw new HttpError(404, "unknown run");
      const q = new URL(req.url ?? "", "http://x").searchParams;
      const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? 100) || 100));
      const events = await write(() => store.readEvents(runId, { after: Number(q.get("after") ?? 0) || 0, limit }));
      const last = events.at(-1)?.position;
      reply(res, 200, { events, ...(last !== undefined && events.length === limit ? { next: last } : {}) });
      return;
    }
    const answerRoute = /^\/api\/v1\/runs\/([^/]+)\/answer$/.exec(path);
    if (answerRoute) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const payload = await body(req);
      const choice = payload.choice;
      if (choice !== "yes" && choice !== "always" && choice !== "no") throw new HttpError(400, "choice must be yes, always or no");
      await scheduler.answer(answerRoute[1]!, choice, optionalString(payload.note, "note"));
      reply(res, 204);
      return;
    }
    if (path === "/api/v1/runs") {
      if (req.method === "GET") {
        const runs = await write(() => store.listRuns().map((id) => {
          const r = store.loadRun(id);
          return {
            id: r.id, project: r.project, task: r.task, createdAt: r.createdAt, status: r.node.status, role: r.role, name: r.name,
            agent: r.node.agent, live: runtime.isAlive(sessionIdOf(r.id, r.node.id)), ...(r.orchestrator ? { orchestrator: r.orchestrator } : {}),
            repo: r.repo, activity: r.node.activity ?? null, runMode: r.node.runMode ?? "terminal", organization: store.organization(r.id), needsAnswer: !!scheduler.pendingRequest(r.id) || !!secrets.pending(sessionIdOf(r.id, NODE_ID)),
          };
        }));
        reply(res, 200, { runs });
        return;
      }
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const payload = await body(req);
      const issueRef = optionalString(payload.issue, "issue");
      let spec: TaskSpec | undefined;
      try { spec = checkSpec(payload.spec); } catch (e) { throw new HttpError(400, (e as Error).message); }
      if (payload.terminal === true) spec = { ...spec, terminal: true };
      if (payload.chat === true) spec = { ...spec, chat: true };
      if (typeof payload.repo !== "string" || (typeof payload.task !== "string" && issueRef === undefined)) {
        throw new HttpError(400, "repo and task must be strings");
      }
      const agent = optionalString(payload.agent, "agent");
      let name = optionalString(payload.name, "name");
      let task = typeof payload.task === "string" ? payload.task : "";
      const model = optionalString(payload.model, "model");
      const role = (optionalString(payload.role, "role") ?? "worker") as Role;
      if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
      // A worker started from inside an orchestrator's session reports back to it.
      const from = optionalString(payload.from, "from");
      let orchestrator: string | undefined;
      let repo = payload.repo;
      let base = optionalString(payload.base, "base");
      if (from !== undefined) {
        const { runId: fromRun } = session(from);
        const sender = await write(() => store.loadRun(fromRun)).catch(() => null);
        if (sender?.role === "orchestrator") {
          orchestrator = sessionIdOf(sender.id, sender.node.id);
          // Its agent runs in its own worktree; a worker belongs to the project, from its base.
          repo = sender.repo;
          base ??= sender.base;
        }
      }
      // A task from an issue: the issue is read now, so the worker starts with it.
      let issue: number | undefined;
      if (issueRef !== undefined) {
        try {
          const root = await repoRoot(repo);
          const gh = await github({ repo: root, project: defaultProjectId(root) } as Run);
          const found = await gh.issue(issueNumber(issueRef, gh.repo));
          issue = found.number;
          task = issueTask(found, task);
          name ??= found.title.slice(0, 100);
        } catch (error) {
          if (error instanceof RunInputError || error instanceof IssueRefError) throw new HttpError(400, error.message);
          throw new HttpError(409, `cannot read issue ${issueRef}: ${(error as Error).message}`);
        }
      }
      let run;
      try {
        run = await newRun({
          repo, task, role, ...(issue ? { issue } : {}), ...(spec ? { spec } : {}),
          ...(name !== undefined ? { name } : {}), ...(model !== undefined ? { model } : {}), ...(orchestrator ? { orchestrator } : {}),
          ...(base !== undefined ? { base } : {}), ...(agent !== undefined ? { agent } : {}),
        });
      } catch (error) {
        if (error instanceof RunInputError) throw new HttpError(400, error.message);
        if (error instanceof SetupError) throw new HttpError(409, error.message);
        throw error;
      }
      reply(res, 201, { runId: run.id });
      return;
    }
    if (path === "/api/v1/routines") {
      if (req.method === "GET") {
        const all = await write(() => store.listRoutines().map((a) => ({ ...a, runs: store.routineRuns(a.id).slice(-5) })));
        reply(res, 200, { routines: all });
        return;
      }
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const payload = await body(req);
      const repoArg = optionalString(payload.repo, "repo");
      const prompt = optionalString(payload.prompt, "prompt");
      const name = optionalString(payload.name, "name")?.trim();
      const cron = optionalString(payload.cron, "cron");
      const zone = optionalString(payload.zone, "zone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const role = (optionalString(payload.role, "role") ?? "worker") as Role;
      const agent = optionalString(payload.agent, "agent");
      if (!repoArg || !prompt?.trim() || !name || !cron) throw new HttpError(400, "repo, name, cron and prompt are required");
      if (!/^[\w.-]{1,64}$/.test(name)) throw new HttpError(400, "a name is one word of at most 64 characters");
      if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
      if (agent !== undefined && !AGENTS.includes(agent as never)) throw new HttpError(400, `agent must be one of ${AGENTS.join(", ")}`);
      let next: string;
      try {
        checkZone(zone);
        next = nextRun(parseCron(cron), zone, new Date()).toISOString();
      } catch (e) { throw new HttpError(400, (e as Error).message); }
      let root: string;
      try { root = await repoRoot(repoArg); } catch (e) { throw new HttpError(400, (e as Error).message); }
      const project = defaultProjectId(root);
      if (await write(() => store.listRoutines(project).some((a) => a.name === name))) throw new HttpError(409, `an routine "${name}" exists`);
      const routine = {
        id: `a${randomBytes(6).toString("hex")}`, project, repo: root, name, prompt: prompt.trim(), role, cron, zone,
        enabled: true, nextRunAt: next, createdAt: new Date().toISOString(), ...(agent ? { agent } : {}),
      };
      await write(() => store.saveRoutine(routine));
      reply(res, 201, routine);
      return;
    }
    const routineRoute = /^\/api\/v1\/routines\/([^/]+)(?:\/(pause|resume|run))?$/.exec(path);
    if (routineRoute) {
      const [, ref, action] = routineRoute;
      const found = await write(() => store.listRoutines().find((a) => a.id === ref || a.name === decodeURIComponent(ref!)));
      if (!found) throw new HttpError(404, `no routine "${decodeURIComponent(ref!)}"`);
      if (req.method === "DELETE" && !action) {
        await write(() => store.deleteRoutine(found.id));
        reply(res, 204);
        return;
      }
      if (req.method !== "POST" || !action) throw new HttpError(405, "method not allowed");
      if (action === "run") {
        // Now, once, without moving its schedule.
        const run = await newRun({ repo: found.repo, task: found.prompt, role: found.role, name: found.name, ...(found.agent ? { agent: found.agent } : {}) });
        await write(() => store.recordRoutineRun({ routineId: found.id, scheduledFor: new Date().toISOString(), runId: run.id, createdAt: new Date().toISOString() }));
        reply(res, 201, { runId: run.id });
        return;
      }
      const enabled = action === "resume";
      // Resuming starts from the next time after now, so missed times are not run.
      const nextRunAt = enabled ? nextRun(parseCron(found.cron), found.zone, new Date()).toISOString() : found.nextRunAt;
      await write(() => store.saveRoutine({ ...found, enabled, nextRunAt }));
      reply(res, 200, { ...found, enabled, nextRunAt });
      return;
    }
    const cleanupRoute = /^\/api\/v1\/cleanup\/([a-f0-9]+)$/.exec(path);
    if (cleanupRoute) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const job = cleanup.get(cleanupRoute[1]!);
      if (!job) throw new HttpError(404, "cleanup job is unavailable, possibly after restart; inspect the worktree and rerun clean for the same run (dirty worktrees remain protected)");
      reply(res, 200, job); return;
    }
    const runRoute = /^\/api\/v1\/runs\/([^/]+)(?:\/(resume|clean|pr|link-pr|stop|merge-policy|review|switch|move-to-worktree))?$/.exec(path);
    if (runRoute) {
      const [, runId, action] = runRoute;
      let run;
      try {
        assertId("run", runId!);
        run = await write(() => store.loadRun(runId!));
      } catch { throw new HttpError(404, "unknown run"); }
      if (action === undefined) {
        if (req.method !== "GET") throw new HttpError(405, "method not allowed");
        const live = runtime.isAlive(sessionIdOf(run.id, run.node.id));
        const pr = await write(() => store.getPr(run.id));
        const terminateOnPrMerge = await write(() => store.getTerminateOnPrMerge(run.id));
        const at = Date.now();
        const silent = noSignal(run.node, at, live, getAgent(run.node.agent).signals);
        // Every conversation its agents had (retries and conflict fixes too), from their own files.
        const conversations = await write(() => store.conversations(run.id));
        const usage = { conversations: conversations.length, ...runUsage(conversations) };
        const reviews = await write(() => store.reviewsOf(run.id));
        const pendingRequest = scheduler.pendingRequest(run.id);
        const chatUsage = run.node.runMode === "chat" ? await write(() => store.chatUsage(run.id)) : null;
        reply(res, 200, { run, live, pr, terminateOnPrMerge, noSignal: silent, usage, reviews, terminal: runtime.hasTerminal(sessionIdOf(run.id, NODE_ID)), ...(pendingRequest ? { pendingRequest } : {}), ...(secrets.pending(sessionIdOf(run.id, NODE_ID)) ? { secretRequest: secrets.pending(sessionIdOf(run.id, NODE_ID)) } : {}), ...(chatUsage ? { chatUsage } : {}), ...(run.sharedWorkspace ? { fork: await write(() => { const f = store.getFork(run.id); return f ? { sourceRun: f.sourceRun, position: f.position, strategy: f.strategy, independent: f.independent ?? false, detached: f.detached ?? false } : null; }) } : {}), now: new Date(at).toISOString() });
        return;
      }
      if (action === "merge-policy") {
        if (req.method !== "PATCH") throw new HttpError(405, "method not allowed");
        const payload = await body(req);
        if (typeof payload.terminateOnPrMerge !== "boolean") throw new HttpError(400, "terminateOnPrMerge must be true or false");
        await write(() => store.setTerminateOnPrMerge(run.id, payload.terminateOnPrMerge as boolean));
        reply(res, 200, { runId: run.id, terminateOnPrMerge: payload.terminateOnPrMerge });
        return;
      }
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      if (action === "stop") {
        const payload = await body(req);
        const workers = await scheduler.stopRun(run.id, { keepWorkers: payload.keepWorkers === true });
        reply(res, 200, { workers });
        return;
      }
      if (action === "switch") {
        const payload = await body(req);
        const to = optionalString(payload.agent, "agent");
        if (!to || !AGENTS.includes(to as never)) throw new HttpError(400, `agent must be one of ${AGENTS.join(", ")}`);
        const model = optionalString(payload.model, "model");
        if (model && (to === "claude" || to === "codex") && MODEL_FAMILIES[to === "claude" ? "codex" : "claude"]?.test(model)) throw new HttpError(400, `model "${model}" is not a ${to} model`);
        await scheduler.switchAgent(run.id, to as never, model, payload.now === true, opts.switchWaitMs);
        reply(res, 202, { runId: run.id, agent: to });
        return;
      }
      if (action === "move-to-worktree") {
        if (branchChanges.has(run.id)) throw new HttpError(409, "workspace is changing");
        branchChanges.add(run.id);
        try {
        if ((await write(() => store.readChat(run.id, { limit: 1 }))).total > 5000) throw new HttpError(409, "history exceeds the handoff context limit");
        const payload = await body(req);
        if (!run.sharedWorkspace || ["busy", "approval"].includes(run.node.activity ?? "")) {
          throw new HttpError(409, "handoff requires a shared fork with a settled turn");
        }
        await scheduler.stopRun(run.id);
        const ref = optionalString(payload.baseRef, "baseRef") ?? "HEAD";
        const from = (await git(["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], run.node.worktree)).trim();
        const branch = branchName(run.id, NODE_ID);
        const path = worktreePath(data, run.project, run.id, NODE_ID);
        await createWorktree({ repo: run.repo, path, branch, from });
        try {
          await write(() => store.ownForkWorkspace(run.id, path));
        } catch (error) {
          await removeWorktree(data, run.repo, path).then(() => git(["branch", "-d", branch], run.repo)).catch(() => {});
          throw error;
        }
        const config = await write(() => store.getConfig(run.project));
        const setup = config.setup ?? "";
        const steps = setup.split(/\r?\n/).map(step => step.trim()).filter(Boolean);
        try {
          await copyListed(run.repo, path, (config.copy ?? "").split(",").map(value => value.trim()).filter(Boolean));
          await linkListed(run.repo, path, (config.symlink ?? "").split(",").map(value => value.trim()).filter(Boolean));
          await runSetup(run.repo, path, run.id, steps);
        } catch (error) {
          throw new HttpError(409, "Worktree created and attached, but setup failed. Inspect it before resuming: " + (error as Error).message);
        }
        reply(res, 201, { runId: run.id, branch, worktree: path, commit: from });
        return;
        } finally { branchChanges.delete(run.id); }
      }
      if (action === "review") {
        reply(res, 202, { reviewId: await scheduler.startReview(run.id, "manual") });
        return;
      }
      if (action === "pr") {
        reply(res, 200, await scheduler.publish(run.id));
        return;
      }
      if (action === "link-pr") {
        const n = (await body(req)).number;
        if (n !== null && (!Number.isSafeInteger(n) || (n as number) < 1)) throw new HttpError(400, "number must be a pull request number, or null to stop watching");
        reply(res, 200, { pr: await scheduler.linkPr(run.id, n as number | null) });
        return;
      }
      if (action === "resume") {
        if (branchChanges.has(run.id)) throw new HttpError(409, "workspace is changing");
        await scheduler.resume(run.id);
        reply(res, 202, { runId: run.id });
        return;
      }
      if (stopping) throw new HttpError(503, "daemon stopping");
      if ([...scriptRuns.values()].some(script => script.worktree === run.node.worktree && (script.starting || runtime.isAlive(script.session)))) throw new HttpError(409, "stop saved scripts before cleaning this workspace");
      reply(res, 202, cleanup.submit(run.id));
      return;
    }
    const projectRadar = /^\/api\/v1\/projects\/([^/]+)\/radar$/.exec(path);
    if (projectRadar) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const project = decodeURIComponent(projectRadar[1]!);
      const runs = await write(() => store.listRuns(project).map((id) => store.loadRun(id)));
      reply(res, 200, { conflicts: await radar(runs) });
      return;
    }
    const snippets = /^\/api\/v1\/projects\/([^/]+)\/snippets(?:\/([^/]+))?$/.exec(path);
    if (snippets) {
      const project = decodeURIComponent(snippets[1]!);
      const name = snippets[2] === undefined ? undefined : decodeURIComponent(snippets[2]);
      if (req.method === "GET" && name === undefined) {
        reply(res, 200, { snippets: await write(() => store.listSnippets(project)) });
        return;
      }
      if (req.method === "PUT" && name !== undefined) {
        const payload = await body(req);
        let snippet;
        try { snippet = checkSnippet(project, name, payload.type, payload.text); } catch (e) { throw new HttpError(400, (e as Error).message); }
        await write(() => store.saveSnippet(snippet));
        reply(res, 200, snippet);
        return;
      }
      if (req.method === "DELETE" && name !== undefined) {
        if (!(await write(() => store.deleteSnippet(project, name)))) throw new HttpError(404, `no snippet "${name}"`);
        reply(res, 204);
        return;
      }
      throw new HttpError(405, "method not allowed");
    }
    const config = /^\/api\/v1\/projects\/([^/]+)\/config$/.exec(path);
    if (config) {
      const project = decodeURIComponent(config[1]!);
      if (req.method === "GET") {
        reply(res, 200, await write(() => store.getConfig(project)));
        return;
      }
      if (req.method !== "PUT") throw new HttpError(405, "method not allowed");
      const payload = await body(req);
      if (!CONFIG_KEYS.includes(payload.key as string)) {
        throw new HttpError(400, `key must be one of ${CONFIG_KEYS.join(", ")}`);
      }
      if (payload.value !== null && typeof payload.value !== "string") throw new HttpError(400, "value must be a string or null");
      if (payload.value !== null && payload.key === "feedback.ciRetries" && !/^(0|[1-9][0-9]?)$/.test(String(payload.value))) throw new HttpError(400,"ciRetries must be an integer from 0 to 99");
      if (payload.value !== null && payload.key === "feedback.reviewMinutes" && (!Number.isFinite(Number(payload.value)) || Number(payload.value) <= 0 || Number(payload.value) > 10080)) throw new HttpError(400,"reviewMinutes must be positive and at most 10080");
      try {
        await write(() => store.setConfig(project, payload.key as string, payload.value as string | null));
      } catch (error) { throw new HttpError(400, (error as Error).message); }
      reply(res, 204);
      return;
    }
    if (req.method === "GET" && !path.startsWith("/api/") && await serveApp(path, res)) return;
    throw new HttpError(404, "unknown route");
  }

  const port = opts.port ?? (process.env.RIVET_PORT === undefined ? 4319 : Number(process.env.RIVET_PORT));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("daemon has no TCP port");
    await writeRunFile(runFile, { pid: process.pid, port: address.port, startedAt: new Date().toISOString() });
    scheduler.watchPrs(opts.prWatchMs ?? 30_000);
    let checkingWakes = false;
    wakeTimer = setInterval(() => {
      if (checkingWakes || stopping) return;
      checkingWakes = true;
      void (async () => {
        notificationWork ??= checkNotifications().catch(error=>opts.onError?.(error)).finally(()=>{notificationWork=undefined;});
        const callers = await write(() => {
          const ready = new Set<string>();
          for (const subscription of store.waitSubscriptions()) {
            const run = store.loadRun(subscription.target);
            const retrying = run.node.status === "failed" && run.node.attempts < (run.spec?.attempts ?? 2);
            const taskDone = ["done","failed","escalated"].includes(run.node.status) && !retrying;
            let turn: {id:string;state:string}|undefined;
            try { turn = subscription.turn ? store.waitTurn(run.id,subscription.turn) : store.waitTurn(run.id); }
            catch {
              store.completeWait(subscription.id,`Wait ended for run ${run.id}: the selected turn moved to an archived conversation branch. Read branch history for details.`);
              ready.add(subscription.caller);continue;
            }
            const turnDone = turn && turn.state !== "working" && (!runtime.isAlive(sessionIdOf(run.id,NODE_ID)) || !!run.node.firstSignalAt);
            if (taskDone || (subscription.scope === "turn" && turnDone)) {
              store.completeWait(subscription.id,`Wait completed for run ${run.id}: ${subscription.scope === "task" ? run.node.status : turn?.state ?? run.node.status}. Read its history for details.`);
              ready.add(subscription.caller);
            }
          }
          return [...ready];
        });
        for (const caller of callers) await scheduler.deliver(caller);
      })().catch((e) => opts.onError?.(e)).finally(() => { checkingWakes = false; });
    },250);
    wakeTimer.unref();
    routineTimer = setInterval(() => { void runDueRoutines().catch((e) => opts.onError?.(e)); }, opts.routineMs ?? 30_000);
    routineTimer.unref();
    pruneTimer = setInterval(() => { void pruneTimelines().catch((e) => opts.onError?.(e)); }, opts.pruneMs ?? 3_600_000);
    pruneTimer.unref();
    void pruneTimelines().catch((e) => opts.onError?.(e));
    void runDueRoutines().catch((e) => opts.onError?.(e));
    scheduler.watchRadar(opts.radarMs ?? 60_000);
    scheduler.watchLimits(opts.limitMs ?? 15_000);
    // Pick up runs that were in flight when the previous daemon stopped.
    for (const id of await write(() => store.listRuns())) {
      void scheduler.recover(id).catch((e) => opts.onError?.(e));
    }
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return { port: address.port, stop, stopped, idle: () => scheduler.idle() };
  } catch (error) {
    await runtime.stopAll();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    throw error;
  }
}
