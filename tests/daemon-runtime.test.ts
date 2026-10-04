import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/agents/agent.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { openStore, type Run } from "../src/store.js";
import { buildTree } from "../src/tree.js";
import { makeDataDir, removeRepo } from "./helpers.js";

let data: string;
let runFile: string;
let daemon: Daemon | undefined;
let leaf: string;

function run(): Run {
  return {
    id: "r1", project: "proj", repo: join(data, "repo"), base: "main", task: "task",
    createdAt: new Date().toISOString(),
    nodes: buildTree({
      runId: "r1", project: "proj", dataDir: data, defaultAgent: "claude",
      plan: { title: "root", prompt: "root", children: [{ title: "leaf", prompt: "leaf" }] },
    }),
  };
}

beforeEach(async () => {
  data = await makeDataDir();
  runFile = join(data, "running.json");
  const r = run();
  const store = openStore(data);
  store.saveRun(r);
  store.close();
  leaf = r.nodes[1]!.worktree;
  await mkdir(leaf, { recursive: true });
  await mkdir(r.nodes[0]!.worktree, { recursive: true });
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await removeRepo(data);
});

// Every node runs the fake agent, so no real model is needed.
async function start(): Promise<Daemon> {
  daemon = await startDaemon({ data, runFile, port: 0, agents: () => getAgent("fake"), stopGraceMs: 500 });
  return daemon;
}

const url = (path: string) => `http://127.0.0.1:${daemon!.port}${path}`;

function post(path: string, body?: unknown): Promise<Response> {
  return fetch(url(path), {
    method: "POST", headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function startLeaf(spec: object): Promise<Response> {
  return post("/api/v1/sessions/r1-root.1/start", { prompt: JSON.stringify(spec) });
}

function activity(): string | null {
  const db = new DatabaseSync(join(data, "rivet.db"));
  try {
    return (db.prepare("SELECT activity FROM nodes WHERE id = 'root.1'").get() as { activity: string | null }).activity;
  } finally { db.close(); }
}

function outbox(): { message: string; delivered: boolean }[] {
  const db = new DatabaseSync(join(data, "rivet.db"));
  try {
    return (db.prepare("SELECT message, delivered_at FROM outbox ORDER BY id").all() as { message: string; delivered_at: string | null }[])
      .map((r) => ({ message: r.message, delivered: r.delivered_at !== null }));
  } finally { db.close(); }
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("starting agents", () => {
  it("starts a leaf with its environment and tracks it until exit", async () => {
    await start();
    const response = await startLeaf({ dumpEnv: true, stayFor: 400 });
    expect(response.status).toBe(202);
    const { launchId } = await response.json() as { launchId: string };
    expect(activity()).toBe("active");
    await until(() => existsSync(join(leaf, "env.json")));
    expect(JSON.parse(await readFile(join(leaf, "env.json"), "utf8"))).toEqual({
      RIVET_SESSION_ID: "r1-root.1",
      RIVET_PROJECT_ID: "proj",
      RIVET_DATA_DIR: data,
      RIVET_RUN_FILE: runFile,
      RIVET_LAUNCH_ID: launchId,
    });
    await until(() => activity() === "exited");
  });

  it("refuses parents, running sessions, missing worktrees and unknown sessions", async () => {
    await start();
    expect((await post("/api/v1/sessions/r1-root/start", {})).status).toBe(409);
    expect((await startLeaf({ stayFor: 5000 })).status).toBe(202);
    expect((await startLeaf({})).status).toBe(409);
    expect((await post("/api/v1/sessions/r1-missing/start", {})).status).toBe(404);
    expect((await post("/api/v1/sessions/r2-root/start", {})).status).toBe(404);
    expect((await post("/api/v1/sessions/r1-root.1/start", { prompt: 5 })).status).toBe(400);
  });

  it("refuses a leaf whose worktree is not on disk", async () => {
    await removeRepo(leaf);
    await start();
    expect((await startLeaf({})).status).toBe(409);
  });

  it("accepts a start with no body", async () => {
    await start();
    expect((await post("/api/v1/sessions/r1-root.1/start")).status).toBe(202);
  });
});

describe("stop and output", () => {
  it("stops a running leaf and shows what it printed", async () => {
    await start();
    await startLeaf({ files: { "a.txt": "a" }, stayFor: 60_000 });
    await until(async () => ((await (await fetch(url("/api/v1/sessions/r1-root.1/output"))).json()) as { lines: string[] }).lines.length > 0);
    expect((await post("/api/v1/sessions/r1-root.1/stop")).status).toBe(204);
    const out = await (await fetch(url("/api/v1/sessions/r1-root.1/output?lines=5"))).json();
    expect(out).toMatchObject({ alive: false, lines: ["wrote a.txt"] });
    await until(() => activity() === "exited");
    expect((await post("/api/v1/sessions/r1-root.1/stop")).status).toBe(404);
  });

  it("404s output for a session never started, and 400s a bad line count", async () => {
    await start();
    expect((await fetch(url("/api/v1/sessions/r1-root.1/output"))).status).toBe(404);
    expect((await fetch(url("/api/v1/sessions/r1-root.1/output?lines=abc"))).status).toBe(400);
  });
});

describe("message delivery", () => {
  it("types a message into a running leaf and marks it delivered", async () => {
    await start();
    await startLeaf({ listen: true });
    expect((await post("/api/v1/sessions/r1-root.1/send", { message: "use the new api" })).status).toBe(202);
    await until(() => existsSync(join(leaf, "inbox.txt")));
    expect(await readFile(join(leaf, "inbox.txt"), "utf8")).toBe("use the new api\n");
    expect(outbox()).toEqual([{ message: "use the new api", delivered: true }]);
  });

  it("keeps messages for a leaf that is not running and delivers them in order on start", async () => {
    await start();
    await post("/api/v1/sessions/r1-root.1/send", { message: "first" });
    await post("/api/v1/sessions/r1-root.1/send", { message: "second" });
    expect(outbox().map((m) => m.delivered)).toEqual([false, false]);
    await startLeaf({ listen: true });
    await until(async () => existsSync(join(leaf, "inbox.txt")) &&
      (await readFile(join(leaf, "inbox.txt"), "utf8")).split("\n").length >= 3);
    expect(await readFile(join(leaf, "inbox.txt"), "utf8")).toBe("first\nsecond\n");
    expect(outbox().map((m) => m.delivered)).toEqual([true, true]);
  });
});

describe("daemon lifecycle with agents", () => {
  it("stops every agent when the daemon stops", async () => {
    await start();
    await startLeaf({ stayFor: 60_000 });
    const out = await (await fetch(url("/api/v1/sessions/r1-root.1/output"))).json() as { alive: boolean };
    expect(out.alive).toBe(true);
    await daemon!.stop();
    daemon = undefined;
    expect(activity()).toBe("exited");
  });

  it("marks sessions left active by a dead daemon as exited on startup", async () => {
    const store = openStore(data);
    store.setActivity("r1", "root.1", "active");
    store.close();
    await start();
    expect(activity()).toBe("exited");
  });
});

describe("concurrent requests", () => {
  it("two starts at once run one agent and still track its exit", async () => {
    await start();
    const results = await Promise.all([startLeaf({ stayFor: 300 }), startLeaf({ stayFor: 300 })]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    await until(() => activity() === "exited");
  });

  it("two sends at once deliver each message exactly once", async () => {
    await start();
    await post("/api/v1/sessions/r1-root.1/send", { message: "queued" });
    await startLeaf({ listen: true, stayFor: 0 });
    await Promise.all([
      post("/api/v1/sessions/r1-root.1/send", { message: "a" }),
      post("/api/v1/sessions/r1-root.1/send", { message: "b" }),
    ]);
    await until(async () => existsSync(join(leaf, "inbox.txt")) &&
      (await readFile(join(leaf, "inbox.txt"), "utf8")).split("\n").length >= 4);
    await new Promise((r) => setTimeout(r, 200));
    const lines = (await readFile(join(leaf, "inbox.txt"), "utf8")).split("\n").filter(Boolean);
    expect(lines.sort()).toEqual(["a", "b", "queued"]);
  });
});
