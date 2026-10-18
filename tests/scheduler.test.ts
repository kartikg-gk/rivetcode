import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, type Agent } from "../src/agents/agent.js";
import { commandRules } from "../src/scheduler/scheduler.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { git } from "../src/git.js";
import type { Run } from "../src/store.js";
import { listWorktrees, waitForTrash } from "../src/worktree.js";
import { makeDataDir, makeRepo, removeRepo } from "./helpers.js";

let repo: string;
let data: string;
let daemon: Daemon | undefined;
let errors: unknown[];

beforeEach(async () => {
  repo = await makeRepo();
  data = await makeDataDir();
  errors = [];
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await waitForTrash();
  await removeRepo(repo);
  await removeRepo(data);
});

async function start(claude?: Agent, more: { radarMs?: number } = {}): Promise<void> {
  daemon = await startDaemon({
    data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500, ...more,
    agents: (name) => (name === "claude" && claude ? claude : getAgent("fake")),
    onError: (e) => errors.push(e),
  });
}

const url = (path: string) => `http://127.0.0.1:${daemon!.port}${path}`;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url(path), {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function projectOf(dir: string): string {
  return dir.split(/[\\/]/).pop()!.toLowerCase().replace(/ /g, "-");
}

const setCfg = (key: string, value: string) => api("PUT", `/api/v1/projects/${encodeURIComponent(projectOf(repo))}/config`, { key, value });

// A worker on the fake agent: its task is the script it runs.
async function spawn(script: object, more: Record<string, unknown> = {}): Promise<string> {
  const res = await api("POST", "/api/v1/runs", { repo, task: JSON.stringify(script), agent: "fake", ...more });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.runId;
}

async function getRun(runId: string): Promise<Run> {
  return (await api("GET", `/api/v1/runs/${runId}`)).json.run;
}

async function settled(runId: string, ms = 20_000): Promise<Run> {
  const end = Date.now() + ms;
  for (;;) {
    const run = await getRun(runId);
    if (["done", "escalated"].includes(run.node.status)) {
      await daemon!.idle();
      return getRun(runId);
    }
    if (Date.now() > end) throw new Error(`run did not settle: ${JSON.stringify([run.node.status, run.node.summary])}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const show = (branch: string, file: string) => git(["show", `${branch}:${file}`], repo);

describe("a worker", () => {
  it("works in its own worktree and branch from the base, and is done when its check and tests pass", async () => {
    await start();
    await setCfg("check", `node -e "require('fs').accessSync('a.txt')"`);
    await setCfg("test", `node -e "process.exit(require('fs').readFileSync('a.txt','utf8') === 'a' ? 0 : 1)"`);
    const runId = await spawn({ files: { "a.txt": "a" }, commit: "add a" }, { name: "add a" });
    const run = await settled(runId);
    expect(run).toMatchObject({ role: "worker", name: "add a", node: { status: "done", attempts: 1 } });
    expect(run.node.branch).toBe(`rivet/${runId}/agent`);
    expect((await show(run.node.branch, "a.txt")).trim()).toBe("a");
    await git(["merge-base", "--is-ancestor", "main", run.node.branch], repo);
    expect(errors).toEqual([]);
  });

  it("commits what its agent left uncommitted", async () => {
    await start();
    const runId = await spawn({ files: { "left.txt": "x" } });
    const run = await settled(runId);
    expect(run.node.status).toBe("done");
    expect((await show(run.node.branch, "left.txt")).trim()).toBe("x");
  });

  it("retries once when its agent fails, then gives up and says why", async () => {
    await start();
    const flaky = await spawn({ failUntilAttempt: 2, files: { "f.txt": "f" }, commit: "f" });
    expect((await settled(flaky)).node).toMatchObject({ status: "done", attempts: 2 });
    const bad = await spawn({ exitCode: 3 });
    const run = await settled(bad);
    expect(run.node).toMatchObject({ status: "escalated", attempts: 2 });
    expect(run.node.summary).toMatch(/gave up after 2 attempts: agent exited with code 3/);
  });

  it("sends work that fails the check back, and keeps the first failure off a later success", async () => {
    await start();
    // Fails the first time it runs, passes after: only a retry can finish.
    await setCfg("check", `node -e "const f=process.argv[1]; if (require('fs').existsSync(f)) process.exit(0); require('fs').writeFileSync(f, 'x'); process.exit(1)" "${join(data, "checked-once")}"`);
    const runId = await spawn({ files: { "a.txt": "a" }, commit: "a" });
    const run = await settled(runId);
    expect(run.node).toMatchObject({ status: "done", attempts: 2 });
    expect(run.node.summary ?? null).toBeNull();
  });

  it("report --done stops the agent and takes the work", async () => {
    await start();
    const runId = await spawn({ files: { "r.txt": "r" }, commit: "r", stayFor: 60_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect((await api("POST", "/api/v1/reports", { sessionId: `${runId}-agent`, kind: "done", message: "ok" })).status).toBe(201);
    expect((await settled(runId)).node.status).toBe("done");
  });
});

describe("an orchestrator", () => {
  it("gets workers that report back to it; its own run stays going", async () => {
    await start();
    const orch = await api("POST", "/api/v1/runs", { repo, task: JSON.stringify({ stayFor: 60_000 }), agent: "fake", role: "orchestrator" });
    expect(orch.status).toBe(201);
    const orchestrator = orch.json.runId as string;
    const worker = await spawn({ files: { "w.txt": "w" }, commit: "w" }, { name: "write w", from: `${orchestrator}-agent` });
    await api("POST", "/api/v1/reports", { sessionId: `${worker}-agent`, kind: "stuck", message: "which file?" });
    expect((await settled(worker)).orchestrator).toBe(`${orchestrator}-agent`);
    expect(await getRun(orchestrator)).toMatchObject({ role: "orchestrator", node: { status: "running" } });
    // A worker spawned from another worker's session reports to nobody.
    const loner = await spawn({ commit: "none" }, { from: `${worker}-agent` });
    expect((await settled(loner)).orchestrator).toBeUndefined();
  });

  it("is told once when two of its workers' work would conflict", async () => {
    await start(undefined, { radarMs: 100 });
    const orchestrator = (await api("POST", "/api/v1/runs", { repo, task: JSON.stringify({ listen: true }), agent: "fake", role: "orchestrator" })).json.runId as string;
    const from = `${orchestrator}-agent`;
    const one = await spawn({ files: { "shared.txt": "one" }, commit: "one", stayFor: 1500 }, { name: "first", from });
    const two = await spawn({ files: { "shared.txt": "two" }, commit: "two", stayFor: 1500 }, { name: "second", from });
    await settled(one);
    await settled(two);
    await new Promise((r) => setTimeout(r, 300));
    const inbox = await readFile(join((await getRun(orchestrator)).node.worktree, "inbox.txt"), "utf8");
    const warnings = inbox.split(/\r?\n/).filter((l) => l.includes("their work will conflict"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Workers ${one} (first), working and ${two} (second), working both change shared.txt`);
    await api("POST", `/api/v1/runs/${orchestrator}/stop`);
  });

  it("refuses an unknown role", async () => {
    await start();
    expect((await api("POST", "/api/v1/runs", { repo, task: "t", role: "boss" })).status).toBe(400);
  });
});

describe("resume and recovery", () => {
  it("resume retries an escalated worker after the user fixed things", async () => {
    await start();
    const runId = await spawn({ failUntilAttempt: 3, files: { "a.txt": "a" }, commit: "a" });
    expect((await settled(runId)).node.status).toBe("escalated");
    expect((await api("POST", `/api/v1/runs/${runId}/resume`)).status).toBe(202);
    expect((await settled(runId)).node.status).toBe("done");
  });

  it("a restarted daemon relaunches a worker that was working", async () => {
    await start();
    const runId = await spawn({ files: { "a.txt": "a" }, commit: "a", stayFor: 60_000 });
    await new Promise((r) => setTimeout(r, 300));
    await daemon!.stop();
    daemon = undefined;
    await start();
    expect((await getRun(runId)).node.status).toBe("running");
    await api("POST", "/api/v1/reports", { sessionId: `${runId}-agent`, kind: "done", message: "ok" });
    expect((await settled(runId)).node.status).toBe("done");
  });

  it("stop holds a worker until resume, and it does not come back on a restart", async () => {
    await start();
    const runId = await spawn({ stayFor: 60_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect((await api("POST", `/api/v1/runs/${runId}/stop`)).status).toBe(204);
    expect((await getRun(runId)).node).toMatchObject({ status: "escalated", attempts: 1, summary: "stopped by the user" });
    await daemon!.stop();
    daemon = undefined;
    await start();
    expect((await api("GET", `/api/v1/runs/${runId}`)).json.live).toBe(false);
  });
});

describe("clean", () => {
  it("removes the worktree and keeps the branch", async () => {
    await start();
    const runId = await spawn({ files: { "a.txt": "a" }, commit: "a" });
    const run = await settled(runId);
    expect((await api("POST", `/api/v1/runs/${runId}/clean`)).json).toEqual({ removed: ["agent"], kept: [] });
    expect(existsSync(run.node.worktree)).toBe(false);
    expect((await git(["branch", "--list", run.node.branch], repo)).trim()).not.toBe("");
  });
});

describe("copy list", () => {
  it("copies listed ignored files into the worktree and never commits them", async () => {
    await writeFile(join(repo, ".gitignore"), ".env\n");
    await git(["add", ".gitignore"], repo);
    await git(["commit", "-q", "-m", "ignore env"], repo);
    await writeFile(join(repo, ".env"), "SECRET=1\n");
    await start();
    await setCfg("copy", ".env, missing.txt");
    const runId = await spawn({ files: { "a.txt": "a" } });
    const run = await settled(runId);
    expect(await readFile(join(run.node.worktree, ".env"), "utf8")).toBe("SECRET=1\n");
    await expect(show(run.node.branch, ".env")).rejects.toThrow();
  });

  it("refuses to copy a file git does not ignore", async () => {
    await writeFile(join(repo, "notes.txt"), "x");
    await start();
    await setCfg("copy", "notes.txt");
    const res = await api("POST", "/api/v1/runs", { repo, task: "t", agent: "fake" });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/only takes files git ignores/);
  });
});

describe("worktree setup", () => {
  it("runs each setup step in the new worktree before the agent starts", async () => {
    await start();
    await setCfg("setup", [
      `node -e "require('fs').writeFileSync('step1.txt', process.env.RIVET_WORKTREE_PATH)"`,
      `node -e "require('fs').writeFileSync('step2.txt', require('fs').existsSync('step1.txt') + ' ' + process.env.RIVET_SOURCE_TREE_PATH)"`,
    ].join("\n"));
    await writeFile(join(repo, ".gitignore"), "step*.txt\n");
    await git(["add", ".gitignore"], repo);
    await git(["commit", "-q", "-m", "ignore steps"], repo);
    const runId = await spawn({ files: { "a.txt": "a" }, commit: "a" });
    const run = await settled(runId);
    expect(await readFile(join(run.node.worktree, "step1.txt"), "utf8")).toBe(run.node.worktree);
    expect(await readFile(join(run.node.worktree, "step2.txt"), "utf8")).toBe(`true ${repo}`);
    expect(run.node.status).toBe("done");
  });

  it("refuses the session when a step fails, showing its output, and leaves nothing behind", async () => {
    await start();
    await setCfg("setup", `node -e "console.error('install broke'); process.exit(2)"`);
    const res = await api("POST", "/api/v1/runs", { repo, task: "t", agent: "fake" });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/setup step 1 .* failed in r\w+:\s+install broke/);
    expect((await git(["branch", "--list", "rivet/*"], repo)).trim()).toBe("");
    expect(await listWorktrees(repo)).toHaveLength(1);
  });
});

describe("what a worker may run", () => {
  it("lets a worker run the check and test commands, and tells it to run the check before done", async () => {
    const seen: { allowedTools?: string[]; prompt?: string; model?: string }[] = [];
    const fake = getAgent("fake");
    const recording: Agent = {
      ...fake,
      launchCommand: async (cfg) => {
        seen.push({ ...(cfg.allowedTools ? { allowedTools: cfg.allowedTools } : {}), ...(cfg.prompt !== undefined ? { prompt: cfg.prompt } : {}), ...(cfg.model ? { model: cfg.model } : {}) });
        return fake.launchCommand({ ...cfg, prompt: JSON.stringify({ files: { "a.txt": "a" }, commit: "a" }) });
      },
    };
    await start(recording);
    await setCfg("check", "node --version");
    await setCfg("test", "git --version");
    const res = await api("POST", "/api/v1/runs", { repo, task: "write a.txt", agent: "claude", model: "haiku" });
    await settled(res.json.runId);
    expect(seen[0]!.allowedTools).toEqual([
      "Bash(rivet:*)", "Bash(git:*)", "Bash(node --version)", "Bash(node --version:*)", "Bash(git --version)", "Bash(git --version:*)",
    ]);
    expect(seen[0]!.prompt).toMatch(/^Your task: write a\.txt/);
    expect(seen[0]!.prompt).toMatch(/Before you report done, run the project's check and make it pass: node --version/);
    expect(seen[0]!.model).toBe("haiku");
  });
});

describe("messages to a headless agent", () => {
  // Takes no input while it works; a resume writes the prompt it was given and commits it.
  function headless(): Agent {
    const fake = getAgent("fake");
    const script = fileURLToPath(new URL("../src/agents/fake-agent.mjs", import.meta.url));
    return {
      ...fake,
      acceptsInput: () => false,
      // Rivet wraps a claude worker's task; the script follows "Your task: ".
      launchCommand: async (cfg) => [process.execPath, script, "--", (cfg.prompt ?? "").split(/\r?\n/)[0]!.replace(/^Your task: /, "")],
      restoreCommand: async (cfg) => [process.execPath, script, "--", JSON.stringify({ files: { "resumed.txt": cfg.prompt ?? "" }, commit: "act on messages" })],
    };
  }

  it("hands queued messages over when its turn ends, before its work is taken", async () => {
    await start(headless());
    const res = await api("POST", "/api/v1/runs", { repo, task: JSON.stringify({ files: { "s.txt": "s" }, commit: "work", stayFor: 2000 }), agent: "claude" });
    const runId = res.json.runId as string;
    const sent = await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "also handle empty input" });
    expect(sent.json.delivery).toBe("turn-end");
    const run = await settled(runId);
    expect(run.node.status).toBe("done");
    const resumed = await readFile(join(run.node.worktree, "resumed.txt"), "utf8");
    expect(resumed).toMatch(/Messages arrived while you worked on your task:\r?\n- also handle empty input/);
  });
});

describe("command permissions", () => {
  it("allows a compound check's whole command, each step, and each step's tool with other arguments", () => {
    expect(commandRules("uv run ruff check src tests && uv run pytest -q -x")).toEqual([
      "Bash(uv run ruff check src tests && uv run pytest -q -x)", "Bash(uv run ruff check src tests && uv run pytest -q -x:*)",
      "Bash(uv run ruff check src tests)", "Bash(uv run ruff check src tests:*)", "Bash(uv run ruff:*)",
      "Bash(uv run pytest -q -x)", "Bash(uv run pytest -q -x:*)", "Bash(uv run pytest:*)",
    ]);
  });

  it("never opens up a bare interpreter", () => {
    expect(commandRules("node scripts/check.mjs")).toEqual(["Bash(node scripts/check.mjs)", "Bash(node scripts/check.mjs:*)"]);
    expect(commandRules("npx tsc --noEmit")).toContain("Bash(npx tsc:*)");
    expect(commandRules("make test")).toContain("Bash(make:*)");
  });
});

describe("an orchestrator after a restart", () => {
  it("waits for resume instead of coming back on its own; stop ends it", async () => {
    await start();
    const orch = (await api("POST", "/api/v1/runs", { repo, task: JSON.stringify({ stayFor: 60_000 }), agent: "fake", role: "orchestrator" })).json.runId as string;
    await new Promise((r) => setTimeout(r, 300));
    await daemon!.stop();
    daemon = undefined;
    await start();
    expect((await api("GET", `/api/v1/runs/${orch}`)).json.live).toBe(false);
    expect((await api("POST", `/api/v1/runs/${orch}/resume`)).status).toBe(202);
    expect((await api("GET", `/api/v1/runs/${orch}`)).json.live).toBe(true);
    expect((await api("POST", `/api/v1/runs/${orch}/stop`)).status).toBe(204);
    expect((await getRun(orch)).node).toMatchObject({ status: "done", summary: "stopped by the user" });
    expect(errors).toEqual([]);
  });
});

describe("an orchestrator's conversation", () => {
  // Starts by staying alive; a resume writes the prompt it was given, then stays alive.
  function resumable(): Agent {
    const fake = getAgent("fake");
    const script = fileURLToPath(new URL("../src/agents/fake-agent.mjs", import.meta.url));
    return {
      ...fake,
      launchCommand: async () => [process.execPath, script, "--", JSON.stringify({ stayFor: 60_000 })],
      restoreCommand: async (cfg) => [process.execPath, script, "--", JSON.stringify({ files: { "resumed.txt": cfg.prompt ?? "" }, stayFor: 60_000 })],
    };
  }

  it("is continued by resume after a restart, told to check status before starting anything", async () => {
    await start(resumable());
    const orch = (await api("POST", "/api/v1/runs", { repo, task: "split the work", agent: "claude", role: "orchestrator" })).json.runId as string;
    await new Promise((r) => setTimeout(r, 300));
    await daemon!.stop();
    daemon = undefined;
    await start(resumable());
    expect((await api("POST", `/api/v1/runs/${orch}/resume`)).status).toBe(202);
    const file = join((await getRun(orch)).node.worktree, "resumed.txt");
    const end = Date.now() + 10_000;
    while (!existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(await readFile(file, "utf8")).toMatch(/^Rivet was restarted\. Before starting anything, run rivet status/);
    expect((await api("POST", `/api/v1/runs/${orch}/stop`)).status).toBe(204);
    expect(errors).toEqual([]);
  });
});
