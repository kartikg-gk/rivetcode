import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dataDir, assertId } from "../paths.js";
import { liveOwner, releaseRunFile, runFilePath, writeRunFile, type RunInfo } from "../runfile.js";
import { openStore } from "../store.js";
import { ACTIVITY_STATES, type ActivityState } from "../tree.js";
import { emptyTrash, waitForTrash } from "../worktree.js";

const BODY_LIMIT = 1024 * 1024;
const REPORT_KINDS = ["done", "stuck", "needs-input"] as const;
type ReportKind = (typeof REPORT_KINDS)[number];

export type Daemon = { port: number; stop(): Promise<void> };
export type DaemonOptions = { data?: string; runFile?: string; port?: number };

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
  try { await emptyTrash(data); }
  catch (error) { store.close(); throw error; }

  let queue = Promise.resolve();
  function write<T>(work: () => T): Promise<T> {
    const result = queue.then(work);
    queue = result.then(() => {}, () => {});
    return result;
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return;
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "internal error";
      reply(res, status, { error: message });
    });
  });

  let stopping: Promise<void> | undefined;
  const onSignal = () => { void stop(); };
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await queue;
      await waitForTrash();
      store.close();
      await releaseRunFile(runFile, process.pid);
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
    const activity = /^\/api\/v1\/sessions\/([^/]+)\/activity$/.exec(path);
    if (activity) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      const { runId, nodeId } = session(activity[1]);
      const payload = await body(req);
      if (!ACTIVITY_STATES.includes(payload.state as ActivityState)) {
        throw new HttpError(400, "invalid activity state");
      }
      const agentSessionId = optionalString(payload.agentSessionId, "agentSessionId");
      const found = await write(() => store.setActivity(runId, nodeId, payload.state as ActivityState, agentSessionId));
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
      reply(res, 202, { id });
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
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return { port: address.port, stop };
  } catch (error) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await waitForTrash();
    store.close();
    throw error;
  }
}
