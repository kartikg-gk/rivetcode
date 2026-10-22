import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { readRunFile, writeRunFile } from "../src/runfile.js";
import { openStore, type Run } from "../src/store.js";
import { makeDataDir, removeRepo, sessionRun } from "./helpers.js";

let data: string;
let runFile: string;
let daemon: Daemon | undefined;

beforeEach(async () => {
  data = await makeDataDir();
  runFile = join(data, "running.json");
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await removeRepo(data);
});

function run(): Run {
  return { ...sessionRun(data, { id: "r1", project: "proj", task: "task" }), repo: join(data, "repo") };
}

function seed(): void {
  const store = openStore(data);
  store.saveRun(run());
  store.close();
}

async function start(): Promise<Daemon> {
  daemon = await startDaemon({ data, runFile, port: 0 });
  return daemon;
}

function url(path: string): string {
  return `http://127.0.0.1:${daemon!.port}${path}`;
}

async function post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(url(path), {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function rows(sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(data, "rivet.db"));
  try { return db.prepare(sql).all() as Record<string, unknown>[]; }
  finally { db.close(); }
}

async function mockHealth(payload: unknown): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no mock port");
  return { port: address.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("daemon ownership and lifecycle", () => {
  it("refuses a second daemon when the recorded owner answers healthz", async () => {
    const first = await start();
    await expect(startDaemon({ data, runFile, port: 0 })).rejects.toThrow(
      `daemon already running (pid ${process.pid}, port ${first.port}); refusing to start`,
    );
  });

  it("overwrites a run file left by a dead pid", async () => {
    await writeRunFile(runFile, { pid: 2147483647, port: 49152, startedAt: new Date().toISOString() });
    const owner = await start();
    expect((await readRunFile(runFile))?.port).toBe(owner.port);
  });

  it("overwrites a live pid with no listening daemon", async () => {
    await writeRunFile(runFile, { pid: process.pid, port: 0, startedAt: new Date().toISOString() });
    await start();
    expect((await readRunFile(runFile))?.port).toBe(daemon!.port);
  });

  it.each([
    ["service", { status: "ok", service: "other", pid: process.pid }],
    ["pid", { status: "ok", service: "rivet-daemon", pid: process.pid + 1 }],
  ])("overwrites a listener with the wrong %s", async (_name, response) => {
    const mock = await mockHealth(response);
    try {
      await writeRunFile(runFile, { pid: process.pid, port: mock.port, startedAt: new Date().toISOString() });
      await start();
      expect((await readRunFile(runFile))?.port).toBe(daemon!.port);
    } finally { await mock.close(); }
  });

  it("records the bound port and removes its run file on stop", async () => {
    const owner = await start();
    expect(await readRunFile(runFile)).toMatchObject({ pid: process.pid, port: owner.port });
    await owner.stop();
    daemon = undefined;
    expect(await readRunFile(runFile)).toBeNull();
  });

  it("upgrades a version 1 database on startup", async () => {
    seed();
    const db = new DatabaseSync(join(data, "rivet.db"));
    db.exec("ALTER TABLE runs DROP COLUMN role; ALTER TABLE runs DROP COLUMN name; ALTER TABLE runs DROP COLUMN orchestrator; ALTER TABLE runs DROP COLUMN model; ALTER TABLE nodes DROP COLUMN shared; DROP TABLE conversations; ALTER TABLE nodes DROP COLUMN started_at; ALTER TABLE nodes DROP COLUMN first_signal_at; DROP TABLE pull_requests; ALTER TABLE runs DROP COLUMN terminate_on_pr_merge; DROP TABLE reports; DROP TABLE outbox; DROP TABLE project_config; ALTER TABLE nodes DROP COLUMN agent_session_id; ALTER TABLE nodes DROP COLUMN activity_at; ALTER TABLE nodes DROP COLUMN finished_at; DELETE FROM schema_migrations WHERE version >= 2");
    db.close();
    await start();
    expect(rows("SELECT version FROM schema_migrations ORDER BY version")).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 },
    ]);
    expect(rows("SELECT id FROM nodes WHERE run_id = 'r1'")).toHaveLength(1);
  });

  it("keeps a successor's run file on stop", async () => {
    const owner = await start();
    await writeRunFile(runFile, { pid: process.pid + 1, port: 9999, startedAt: new Date().toISOString() });
    await owner.stop();
    daemon = undefined;
    expect((await readRunFile(runFile))?.pid).toBe(process.pid + 1);
  });

  it("restricts shutdown and closes after a successful reply", async () => {
    await start();
    const forbidden = await post("/shutdown", {}, { Origin: "https://evil.example" });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ status: "forbidden" });
    const accepted = await post("/shutdown", {});
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ status: "shutting_down", pid: process.pid });
    await daemon!.stop();
    daemon = undefined;
    await expect(fetch(`http://127.0.0.1:${new URL(accepted.url).port}/healthz`)).rejects.toThrow();
  });
});

describe("daemon routes", () => {
  beforeEach(async () => { seed(); await start(); });

  it("answers healthz and rejects unknown routes or methods", async () => {
    const health = await fetch(url("/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "rivet-daemon", pid: process.pid });
    expect((await fetch(url("/missing"))).status).toBe(404);
    expect((await post("/healthz", {})).status).toBe(405);
  });

  it("saves activity and an agent session id", async () => {
    const response = await post("/api/v1/sessions/r1-agent/activity", {
      state: "blocked", agentSessionId: "agent-42",
    });
    expect(response.status).toBe(204);
    await daemon!.stop();
    daemon = undefined;
    const store = openStore(data);
    try {
      expect(store.loadRun("r1").node).toMatchObject({ activity: "blocked", agentSessionId: "agent-42" });
    } finally { store.close(); }
  });

  it("rejects invalid activity, session ids, and unknown sessions", async () => {
    expect((await post("/api/v1/sessions/r1-agent/activity", { state: "asleep" })).status).toBe(400);
    expect((await post("/api/v1/sessions/bad/activity", { state: "active" })).status).toBe(400);
    expect((await post("/api/v1/sessions/r1-missing/activity", { state: "active" })).status).toBe(404);
  });

  it("stores reports without changing the session status", async () => {
    const response = await post("/api/v1/reports", { sessionId: "r1-agent", kind: "done", message: "ready" });
    expect(response.status).toBe(201);
    expect(await response.json()).toHaveProperty("id");
    await daemon!.stop();
    daemon = undefined;
    expect(rows("SELECT run_id, node_id, kind, message FROM reports")).toEqual([
      { run_id: "r1", node_id: "agent", kind: "done", message: "ready" },
    ]);
    expect(rows("SELECT status FROM nodes WHERE id = 'agent'")[0]).toEqual({ status: "pending" });
  });

  it("rejects invalid reports and unknown sessions", async () => {
    expect((await post("/api/v1/reports", { sessionId: "r1-agent", kind: "other" })).status).toBe(400);
    expect((await post("/api/v1/reports", { sessionId: "r1-missing", kind: "done" })).status).toBe(404);
  });

  it("queues messages for later delivery", async () => {
    const response = await post("/api/v1/sessions/r1-agent/send", { message: "hello", from: "root" });
    expect(response.status).toBe(202);
    expect(await response.json()).toHaveProperty("id");
    await daemon!.stop();
    daemon = undefined;
    expect(rows("SELECT run_id, node_id, from_session, message, delivered_at FROM outbox")).toEqual([
      { run_id: "r1", node_id: "agent", from_session: "root", message: "hello", delivered_at: null },
    ]);
  });

  it("rejects invalid messages and unknown sessions", async () => {
    expect((await post("/api/v1/sessions/r1-agent/send", {})).status).toBe(400);
    expect((await post("/api/v1/sessions/r1-missing/send", { message: "hi" })).status).toBe(404);
  });

  it("rejects invalid JSON and bodies above 1 MiB", async () => {
    for (const path of [
      "/api/v1/reports",
      "/api/v1/sessions/r1-agent/activity",
      "/api/v1/sessions/r1-agent/send",
    ]) {
      expect((await post(path, "{broken")).status).toBe(400);
      expect((await post(path, { message: "x".repeat(1024 * 1024) })).status).toBe(413);
    }
  });
});
