import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { getAgent, type Agent } from "../agents/agent.js";
import { findClaude, findCodex } from "../agents/locate.js";
import { claudePlanner } from "../planner/claude-runner.js";
import { githubClient, githubToken, repoSlug, type GitHub } from "../github/github.js";
import { extractReplan, replanPrompt } from "../planner/planner.js";
import { dataDir, assertId } from "../paths.js";
import { git } from "../git.js";
import { liveOwner, releaseRunFile, runFilePath, writeRunFile, type RunInfo } from "../runfile.js";
import { sessionIdOf } from "../runtime/env.js";
import { createRuntime } from "../runtime/runtime.js";
import { radar } from "../scheduler/radar.js";
import { cleanRun, prepareRun, RunInputError, SetupError } from "../scheduler/runs.js";
import { createScheduler, SchedulerError } from "../scheduler/scheduler.js";
import { openStore, RunStoreError, type Run } from "../store.js";
import { ACTIVITY_STATES, noSignal, type ActivityState, type Node } from "../tree.js";
import { emptyTrash, waitForTrash } from "../worktree.js";

const BODY_LIMIT = 1024 * 1024;
// Per-project settings: the check after every merge, the full test at the root, the default agent.
const CONFIG_KEYS = ["check", "test", "worker.agent", "worker.permission", "worker.model", "worker.allowedTools", "worker.mode", "planner.model", "pr", "github.repo", "copy", "setup"];
const REPORT_KINDS = ["done", "stuck", "needs-input"] as const;
type ReportKind = (typeof REPORT_KINDS)[number];

// stopped resolves once the daemon has fully shut down (by stop(), a signal or /shutdown).
export type Daemon = { port: number; stop(): Promise<void>; stopped: Promise<void>; idle(): Promise<void> };
export type DaemonOptions = {
  data?: string;
  runFile?: string;
  port?: number;
  // Which adapter runs a node's agent; tests swap in the fake agent.
  agents?: (name: Node["agent"]) => Agent;
  stopGraceMs?: number;
  checkTimeoutMs?: number;
  // Rewrites a twice-failed leaf's instructions; defaults to a read-only claude planner.
  replan?(run: Run, node: Node, why: string): Promise<string | null>;
  // GitHub access for a run (tests pass a client for a mock API).
  github?(run: Run): Promise<GitHub>;
  // How often open pull requests are checked.
  prWatchMs?: number;
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

  const store = openStore(data);
  try {
    store.exitStaleSessions();
    await emptyTrash(data);
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

  const replan = opts.replan ?? (async (run: Run, node: Node, why: string): Promise<string | null> => {
    // A scripted test agent has nothing to re-plan.
    if (node.agent === "fake") return null;
    let binary: string;
    try { binary = claudeBinary ??= findClaude(); } catch { return null; }
    const config = await write(() => store.getConfig(run.project));
    const model = config["planner.model"] ?? config["worker.model"];
    const planner = claudePlanner({ binary, repo: node.worktree, ...(model ? { model } : {}) });
    return extractReplan(await planner(replanPrompt(run.task, node, why), { resume: false }));
  });
  const github = opts.github ?? (async (run: Run): Promise<GitHub> => {
    const remote = (await git(["remote", "get-url", "origin"], run.repo).catch(() => "")).trim();
    const config = await write(() => store.getConfig(run.project));
    const repo = config["github.repo"] ?? repoSlug(remote);
    if (!repo) throw new Error(`origin is not a GitHub repository (${remote || "no origin"}); set github.repo`);
    return githubClient({ repo, token: await githubToken(process.env, remote) });
  });
  const scheduler = createScheduler({
    data, runFile, store, write, runtime, agents, launches, replan, github,
    ...(opts.checkTimeoutMs ? { checkTimeoutMs: opts.checkTimeoutMs } : {}),
    onError: (error) => { opts.onError?.(error); },
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      const status = error instanceof HttpError || error instanceof SchedulerError ? error.status : 500;
      const message = error instanceof Error ? error.message : "internal error";
      reply(res, status, { error: message });
    });
  });

  // Starts a leaf's agent by hand with the given prompt; the tree status is not touched.
  async function startSession(runId: string, nodeId: string, prompt?: string): Promise<string> {
    let run;
    try { run = await write(() => store.loadRun(runId)); }
    catch (error) {
      if (error instanceof RunStoreError) throw new HttpError(404, "unknown session");
      throw error;
    }
    const node = run.nodes.find((n) => n.id === nodeId);
    if (!node) throw new HttpError(404, "unknown session");
    if (node.kind !== "leaf") throw new HttpError(409, "only leaves run agents");
    return scheduler.launch(run, node, prompt);
  }

  let stopping: Promise<void> | undefined;
  let markStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { markStopped = resolve; });
  const onSignal = () => { void stop(); };
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await scheduler.shutdown();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await queue;
      await waitForTrash();
      store.close();
      await releaseRunFile(runFile, process.pid);
      markStopped();
    })();
    return stopping;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
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
    const control = /^\/api\/v1\/sessions\/([^/]+)\/(start|stop|output|attach|input|resize|sync)$/.exec(path);
    if (control) {
      const [, id, action] = control;
      const { runId, nodeId } = session(id);
      const sessionId = sessionIdOf(runId, nodeId);
      if (action === "sync") {
        if (req.method !== "POST") throw new HttpError(405, "method not allowed");
        const payload = await body(req);
        try { await write(() => store.loadRun(runId)); } catch { throw new HttpError(404, "unknown session"); }
        reply(res, 200, await scheduler.sync(runId, nodeId, { byAgent: payload.byAgent === true }));
        return;
      }
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
      if (payload.state !== undefined && !ACTIVITY_STATES.includes(payload.state as ActivityState)) {
        throw new HttpError(400, "invalid activity state");
      }
      const state = (payload.state as ActivityState | undefined) ?? null;
      const agentSessionId = optionalString(payload.agentSessionId, "agentSessionId");
      if (state === null && agentSessionId === undefined) throw new HttpError(400, "state or agentSessionId is required");
      // Hooks of an agent from an earlier launch may still fire; only the current launch counts.
      const launchId = optionalString(payload.launchId, "launchId");
      if (launchId !== undefined && launches.get(sessionIdOf(runId, nodeId)) !== launchId) {
        reply(res, 204);
        return;
      }
      const found = await write(() => store.recordSignal(runId, nodeId, state, agentSessionId));
      if (!found) throw new HttpError(404, "unknown session");
      reply(res, 204);
      return;
    }
    if (path === "/api/v1/reports") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const payload = await body(req);
      const { runId, nodeId } = session(payload.sessionId);
      if (!REPORT_KINDS.includes(payload.kind as ReportKind)) throw new HttpError(400, "invalid report kind");
      const message = optionalString(payload.message, "message");
      const id = await write(() => store.createReport(runId, nodeId, payload.kind as ReportKind, message));
      if (id === null) throw new HttpError(404, "unknown session");
      void scheduler.onReport(runId, nodeId, payload.kind as string).catch((e) => opts.onError?.(e));
      reply(res, 201, { id });
      return;
    }
    const send = /^\/api\/v1\/sessions\/([^/]+)\/send$/.exec(path);
    if (send) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const { runId, nodeId } = session(send[1]);
      const payload = await body(req);
      if (typeof payload.message !== "string") throw new HttpError(400, "message must be a string");
      const from = optionalString(payload.from, "from");
      const id = await write(() => store.queueMessage(runId, nodeId, payload.message as string, from));
      if (id === null) throw new HttpError(404, "unknown session");
      if (runtime.isAlive(sessionIdOf(runId, nodeId))) await scheduler.deliver(runId, nodeId);
      reply(res, 202, { id });
      return;
    }
    if (path === "/api/v1/runs") {
      if (req.method === "GET") {
        const runs = await write(() => store.listRuns().map((id) => {
          const r = store.loadRun(id);
          return { id: r.id, project: r.project, task: r.task, createdAt: r.createdAt, status: r.nodes[0]!.status };
        }));
        reply(res, 200, { runs });
        return;
      }
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const payload = await body(req);
      if (typeof payload.repo !== "string" || typeof payload.task !== "string") {
        throw new HttpError(400, "repo and task must be strings");
      }
      if (!payload.plan || typeof payload.plan !== "object") throw new HttpError(400, "plan must be an object");
      const base = optionalString(payload.base, "base");
      const agent = optionalString(payload.agent, "agent");
      let run;
      try {
        run = await prepareRun({
          data, repo: payload.repo, task: payload.task, plan: payload.plan as never,
          ...(base !== undefined ? { base } : {}), ...(agent !== undefined ? { agent } : {}),
          defaultAgentFor: (project) => store.getConfig(project)["worker.agent"],
          copyFor: (project) => (store.getConfig(project).copy ?? "").split(",").map((f) => f.trim()).filter(Boolean),
          // One command per line, run in order in every new worktree.
          setupFor: (project) => (store.getConfig(project).setup ?? "").split(/\r?\n/).map((c) => c.trim()).filter(Boolean),
        });
      } catch (error) {
        if (error instanceof RunInputError) throw new HttpError(400, error.message);
        if (error instanceof SetupError) throw new HttpError(409, error.message);
        throw error;
      }
      await write(() => store.saveRun(run));
      void scheduler.startRun(run.id).catch((e) => opts.onError?.(e));
      reply(res, 201, { runId: run.id });
      return;
    }
    const runRoute = /^\/api\/v1\/runs\/([^/]+)(?:\/(resume|clean|pr|skip|radar|merge-policy))?$/.exec(path);
    if (runRoute) {
      const [, runId, action] = runRoute;
      let run;
      try {
        assertId("run", runId!);
        run = await write(() => store.loadRun(runId!));
      } catch { throw new HttpError(404, "unknown run"); }
      if (action === undefined) {
        if (req.method !== "GET") throw new HttpError(405, "method not allowed");
        const live = Object.fromEntries(run.nodes.map((n) => [n.id, runtime.isAlive(sessionIdOf(run.id, n.id))]));
        const pr = await write(() => store.getPr(run.id));
        const terminateOnPrMerge = await write(() => store.getTerminateOnPrMerge(run.id));
        const at = Date.now();
        const silent = run.nodes.filter((n) => noSignal(n, at, live[n.id]!, getAgent(n.agent).signals)).map((n) => n.id);
        reply(res, 200, { run, live, pr, terminateOnPrMerge, noSignal: silent, now: new Date(at).toISOString() });
        return;
      }
      if (action === "radar") {
        if (req.method !== "GET") throw new HttpError(405, "method not allowed");
        reply(res, 200, { conflicts: await radar(run) });
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
      if (action === "skip") {
        const payload = await body(req);
        if (typeof payload.node !== "string") throw new HttpError(400, "node must be a string");
        await scheduler.skip(run.id, payload.node);
        reply(res, 204);
        return;
      }
      if (action === "pr") {
        reply(res, 200, await scheduler.publish(run.id));
        return;
      }
      if (action === "resume") {
        await scheduler.resume(run.id);
        reply(res, 202, { runId: run.id });
        return;
      }
      for (const n of run.nodes) await scheduler.stopSession(sessionIdOf(run.id, n.id));
      reply(res, 200, await cleanRun(data, run));
      return;
    }
    const active = /^\/api\/v1\/projects\/([^/]+)\/active-files$/.exec(path);
    if (active) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const project = decodeURIComponent(active[1]!);
      const runs = await write(() => store.listRuns(project).map((id) => store.loadRun(id)));
      const files: { file: string; runId: string; nodeId: string }[] = [];
      for (const r of runs) {
        const root = r.nodes[0]!;
        if (["done", "failed", "skipped"].includes(root.status) || r.nodes.every((n) => n.status === "pending")) continue;
        for (const n of r.nodes.filter((x) => x.kind === "leaf" && x.status !== "skipped")) {
          const changed = await git(["diff", "--name-only", `${r.base}...${n.branch}`], r.repo)
            .then((out) => out.split(/\r?\n/).filter(Boolean), () => [] as string[]);
          for (const file of new Set([...n.files, ...changed])) files.push({ file, runId: r.id, nodeId: n.id });
        }
      }
      reply(res, 200, { files });
      return;
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
      try {
        await write(() => store.setConfig(project, payload.key as string, payload.value as string | null));
      } catch (error) { throw new HttpError(400, (error as Error).message); }
      reply(res, 204);
      return;
    }
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
    await waitForTrash();
    store.close();
    throw error;
  }
}
