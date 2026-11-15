import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/agents/agent.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { openStore, type Run } from "../src/store.js";
import { makeDataDir, removeRepo, sessionRun } from "./helpers.js";

let data: string;
let runFile: string;
let daemon: Daemon | undefined;
let worktree: string;

function run(): Run {
  return { ...sessionRun(data, { id: "r1", project: "proj", task: "task" }), repo: join(data, "repo") };
}

beforeEach(async () => {
  data = await makeDataDir();
  runFile = join(data, "running.json");
  const r = run();
  const store = openStore(data);
  store.saveRun(r);
  store.close();
  worktree = r.node.worktree;
  await mkdir(worktree, { recursive: true });
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await removeRepo(data);
});

// Every node runs the fake agent, so no real model is needed.
async function start(): Promise<Daemon> {
  daemon = await startDaemon({ data, runFile, port: 0, agents: () => getAgent("fake"), stopWaitMs: 500 });
  return daemon;
}

const url = (path: string) => `http://127.0.0.1:${daemon!.port}${path}`;

function post(path: string, body?: unknown): Promise<Response> {
  return fetch(url(path), {
    method: "POST", headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function startAgent(spec: object): Promise<Response> {
  return post("/api/v1/sessions/r1-agent/start", { prompt: JSON.stringify(spec) });
}

function activity(): string | null {
  const db = new DatabaseSync(join(data, "rivet.db"));
  try {
    return (db.prepare("SELECT activity FROM nodes WHERE id = 'agent'").get() as { activity: string | null }).activity;
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
  it("starts a session with its environment and tracks it until exit", async () => {
    await start();
    const response = await startAgent({ dumpEnv: true, stayFor: 400 });
    expect(response.status).toBe(202);
    const { launchId } = await response.json() as { launchId: string };
    // Idle until the agent itself reports activity.
    expect(activity()).toBe("idle");
    await until(() => existsSync(join(worktree, "env.json")));
    expect(JSON.parse(await readFile(join(worktree, "env.json"), "utf8"))).toEqual({
      RIVET_SESSION_ID: "r1-agent",
      RIVET_PROJECT_ID: "proj",
      RIVET_DATA_DIR: data,
      RIVET_RUN_FILE: runFile,
      RIVET_LAUNCH_ID: launchId,
      RIVET_ATTEMPT: "0",
      RIVET_CLAUDE_TERMINAL_HISTORY: "0",
      RIVET_NODE: process.execPath,
    });
    await until(() => activity() === "ended");
  });

  it("refuses running sessions, missing worktrees and unknown sessions", async () => {
    await start();
    expect((await post("/api/v1/sessions/r1-other/start", {})).status).toBe(404);
    expect((await startAgent({ stayFor: 5000 })).status).toBe(202);
    expect((await startAgent({})).status).toBe(409);
    expect((await post("/api/v1/sessions/r1-missing/start", {})).status).toBe(404);
    expect((await post("/api/v1/sessions/r2-root/start", {})).status).toBe(404);
    expect((await post("/api/v1/sessions/r1-agent/start", { prompt: 5 })).status).toBe(400);
  });

  it("refuses a worktree whose worktree is not on disk", async () => {
    await removeRepo(worktree);
    await start();
    expect((await startAgent({})).status).toBe(409);
  });

  it("accepts a start with no body", async () => {
    await start();
    expect((await post("/api/v1/sessions/r1-agent/start")).status).toBe(202);
  });
});

describe("stop and output", () => {
  it("stops a running session and shows what it printed", async () => {
    await start();
    await startAgent({ files: { "a.txt": "a" }, stayFor: 60_000 });
    await until(async () => ((await (await fetch(url("/api/v1/sessions/r1-agent/output"))).json()) as { lines: string[] }).lines.length > 0);
    expect((await post("/api/v1/sessions/r1-agent/stop")).status).toBe(204);
    const out = await (await fetch(url("/api/v1/sessions/r1-agent/output?lines=5"))).json();
    expect(out).toMatchObject({ alive: false, lines: ["wrote a.txt"] });
    await until(() => activity() === "ended");
    expect((await post("/api/v1/sessions/r1-agent/stop")).status).toBe(404);
  });

  it("404s output for a session never started, and 400s a bad line count", async () => {
    await start();
    expect((await fetch(url("/api/v1/sessions/r1-agent/output"))).status).toBe(404);
    expect((await fetch(url("/api/v1/sessions/r1-agent/output?lines=abc"))).status).toBe(400);
  });
});

describe("message delivery", () => {
  it("types a message into a running session and marks it delivered", async () => {
    await start();
    await startAgent({ listen: true });
    expect((await post("/api/v1/sessions/r1-agent/send", { message: "use the new api" })).status).toBe(202);
    await until(() => existsSync(join(worktree, "inbox.txt")));
    expect(await readFile(join(worktree, "inbox.txt"), "utf8")).toBe("use the new api\n");
    expect(outbox()).toEqual([{ message: "use the new api", delivered: true }]);
  });

  it("keeps messages for a session that is not running and delivers them in order on start", async () => {
    await start();
    await post("/api/v1/sessions/r1-agent/send", { message: "first" });
    await post("/api/v1/sessions/r1-agent/send", { message: "second" });
    expect(outbox().map((m) => m.delivered)).toEqual([false, false]);
    await startAgent({ listen: true });
    await until(async () => existsSync(join(worktree, "inbox.txt")) &&
      (await readFile(join(worktree, "inbox.txt"), "utf8")).split("\n").length >= 3);
    expect(await readFile(join(worktree, "inbox.txt"), "utf8")).toBe("first\nsecond\n");
    expect(outbox().map((m) => m.delivered)).toEqual([true, true]);
  });
});

describe("daemon lifecycle with agents", () => {
  it("stops every agent when the daemon stops", async () => {
    await start();
    await startAgent({ stayFor: 60_000 });
    const out = await (await fetch(url("/api/v1/sessions/r1-agent/output"))).json() as { alive: boolean };
    expect(out.alive).toBe(true);
    await daemon!.stop();
    daemon = undefined;
    expect(activity()).toBe("ended");
  });

  it("marks sessions left active by a dead daemon as exited on startup", async () => {
    const store = openStore(data);
    store.setActivity("r1", "agent", "busy");
    store.close();
    await start();
    expect(activity()).toBe("ended");
  });
});

describe("concurrent requests", () => {
  it("two starts at once run one agent and still track its exit", async () => {
    await start();
    const results = await Promise.all([startAgent({ stayFor: 300 }), startAgent({ stayFor: 300 })]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    await until(() => activity() === "ended");
  });

  it("two sends at once deliver each message exactly once", async () => {
    await start();
    await post("/api/v1/sessions/r1-agent/send", { message: "queued" });
    await startAgent({ listen: true, stayFor: 0 });
    await Promise.all([
      post("/api/v1/sessions/r1-agent/send", { message: "a" }),
      post("/api/v1/sessions/r1-agent/send", { message: "b" }),
    ]);
    await until(async () => existsSync(join(worktree, "inbox.txt")) &&
      (await readFile(join(worktree, "inbox.txt"), "utf8")).split("\n").length >= 4);
    await new Promise((r) => setTimeout(r, 200));
    const lines = (await readFile(join(worktree, "inbox.txt"), "utf8")).split("\n").filter(Boolean);
    expect(lines.sort()).toEqual(["a", "b", "queued"]);
  });
});

describe("hook activity from agents", () => {
  it("saves an agent session id without a state, and ignores events from an older launch", async () => {
    await start();
    const first = await (await startAgent({ stayFor: 60_000 })).json() as { launchId: string };
    expect((await post("/api/v1/sessions/r1-agent/activity", { agentOwnId: "conv-1", launchId: first.launchId })).status).toBe(204);
    expect((await post("/api/v1/sessions/r1-agent/activity", { state: "busy", launchId: "0000000000000000" })).status).toBe(204);
    expect(activity()).toBe("idle");
    expect((await post("/api/v1/sessions/r1-agent/activity", { state: "busy", launchId: first.launchId })).status).toBe(204);
    expect(activity()).toBe("busy");
    expect((await post("/api/v1/sessions/r1-agent/activity", {})).status).toBe(400);
    await daemon!.stop();
    daemon = undefined;
    const store = openStore(data);
    try {
      expect(store.loadRun("r1").node.agentOwnId).toBe("conv-1");
      expect(store.loadRun("r1").node.firstHeardAt).toBeDefined();
      expect(store.conversations("r1")).toEqual([{ nodeId: "agent", agent: "claude", id: "conv-1" }]);
    }
    finally { store.close(); }
  });
});

describe("interactive mode (terminal sessions)", () => {
  async function interactive(): Promise<void> {
    await start();
    const res = await fetch(url("/api/v1/projects/proj/config"), {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "worker.view", value: "interactive" }),
    });
    expect(res.status).toBe(204);
  }

  it("streams the terminal to an attached client and takes typed lines", async () => {
    await interactive();
    const db = new DatabaseSync(join(data, "rivet.db"));
    db.exec("UPDATE nodes SET status = 'running'");
    db.close();
    // A manual start uses the prompt as given; the scheduler path is covered elsewhere.
    expect((await startAgent({ files: { "a.txt": "a" }, listen: true })).status).toBe(202);
    const attached = await fetch(url("/api/v1/sessions/r1-agent/attach"));
    expect(attached.status).toBe(200);
    const reader = attached.body!.getReader();
    let text = "";
    const readUntil = async (needle: string) => {
      const end = Date.now() + 10_000;
      while (!text.includes(needle)) {
        if (Date.now() > end) throw new Error(`no "${needle}" in ${JSON.stringify(text)}`);
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    };
    await readUntil("wrote a.txt");
    expect((await post("/api/v1/sessions/r1-agent/send", { message: "hello there" })).status).toBe(202);
    await readUntil("got hello there");
    expect((await post("/api/v1/sessions/r1-agent/resize", { cols: 100, rows: 30 })).status).toBe(204);
    expect((await post("/api/v1/sessions/r1-agent/resize", { cols: 0, rows: 30 })).status).toBe(400);
    expect((await post("/api/v1/sessions/r1-agent/input", { data: "/exit\r" })).status).toBe(204);
    await readUntil("");
    await reader.cancel();
    await until(() => activity() === "ended");
    expect((await post("/api/v1/sessions/r1-agent/input", { data: "x" })).status).toBe(404);
  });

  it("input to a piped session is refused", async () => {
    await start();
    await startAgent({ stayFor: 5000 });
    expect((await post("/api/v1/sessions/r1-agent/input", { data: "x" })).status).toBe(409);
  });
});
