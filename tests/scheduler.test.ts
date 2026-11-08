import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, type Agent } from "../src/agents/agent.js";
import { commandRules, modelFor } from "../src/scheduler/scheduler.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { git } from "../src/git.js";
import type { Run } from "../src/store.js";
import { listWorktrees } from "../src/worktree.js";
import { cleanupResult, makeDataDir, makeRepo, removeRepo } from "./helpers.js";

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
  await removeRepo(repo);
  await removeRepo(data);
});

async function start(claude?: Agent, more: { radarMs?: number; limitMs?: number; switchWaitMs?: number } = {}): Promise<void> {
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
  it("commits through the launch-bound broker and preserves output written after report done", async () => {
    await start();
    const gate = join(data, "finish-turn");
    const id = await spawn({ files: { "change.txt": "worker edit" }, dumpEnv: true, finishGate: gate, finalReply: "final reply after reporting" }, { agent: "codex" });
    const run = await getRun(id);
    const envFile = join(run.node.worktree, "env.json");
    const deadline = Date.now() + 10000;
    while (!existsSync(envFile)) {
      if (Date.now() >= deadline) throw new Error("worker did not start");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const { RIVET_LAUNCH_ID: launchId } = JSON.parse(await readFile(envFile, "utf8"));
    const session = `/api/v1/sessions/${id}-agent`;
    expect((await api("POST", session + "/commit", { launchId: "stale", message: "Save edit" })).status).toBe(403);
    const commit = await api("POST", session + "/commit", { launchId, message: "Save edit" });
    expect(commit.status, JSON.stringify(commit.json)).toBe(200);
    expect(commit.json.committed).toBe(true);
    expect((await show(run.node.branch, "change.txt")).trim()).toBe("worker edit");
    expect((await api("POST", "/api/v1/reports", { sessionId: `${id}-agent`, kind: "done", message: "finished work" })).status).toBe(201);
    const history = () => api("GET", `/api/v1/runs/${id}/timeline?view=activity`);
    while (!(await history()).json.items.some((item: { text: string }) => item.text.includes("reported done"))) {
      if (Date.now() >= deadline) throw new Error("done report was not recorded");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect((await getRun(id)).node.status).toBe("running");
    await writeFile(gate, "finish");
    expect((await settled(id)).node.status).toBe("done");
    expect((await history()).json.items).toContainEqual(expect.objectContaining({ kind: "assistant", text: "final reply after reporting" }));
  });
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

  it("is told when a worker finishes on work that clashes with a finished one, without waiting for the timer", async () => {
    await start(undefined, { radarMs: 3_600_000 });
    const orchestrator = (await api("POST", "/api/v1/runs", { repo, task: JSON.stringify({ listen: true }), agent: "fake", role: "orchestrator" })).json.runId as string;
    const from = `${orchestrator}-agent`;
    const one = await spawn({ files: { "shared.txt": "one" }, commit: "one" }, { name: "first", from });
    await settled(one);
    const two = await spawn({ files: { "shared.txt": "two" }, commit: "two" }, { name: "second", from });
    await settled(two);
    await new Promise((r) => setTimeout(r, 300));
    const inbox = await readFile(join((await getRun(orchestrator)).node.worktree, "inbox.txt"), "utf8");
    const warnings = inbox.split(/\r?\n/).filter((l) => l.includes("their work will conflict"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Workers ${one} (first), done and ${two} (second), done both change shared.txt`);
    expect(warnings[0]).toContain("Once one is merged, Rivet brings the other up to date");
    await api("POST", `/api/v1/runs/${orchestrator}/stop`);
  });

  it("is told once when a worker waits for a permission answer", async () => {
    await start();
    const orchestrator = (await api("POST", "/api/v1/runs", { repo, task: JSON.stringify({ listen: true }), agent: "fake", role: "orchestrator" })).json.runId as string;
    const worker = await spawn({ stayFor: 60_000 }, { from: `${orchestrator}-agent` });
    await new Promise((r) => setTimeout(r, 300));
    for (const state of ["approval", "approval"]) await api("POST", `/api/v1/sessions/${worker}-agent/activity`, { state });
    await new Promise((r) => setTimeout(r, 400));
    const inbox = await readFile(join((await getRun(orchestrator)).node.worktree, "inbox.txt"), "utf8");
    expect(inbox.split(/\r?\n/).filter((l) => l.includes("is waiting for a permission answer"))).toHaveLength(1);
    expect(inbox).toContain(`Answer with: rivet answer ${worker} yes|always|no`);
    await api("POST", `/api/v1/runs/${orchestrator}/stop`, {});
  });

  it("refuses a model that belongs to the other agent", async () => {
    await start();
    const codex = await api("POST", "/api/v1/runs", { repo, task: "x", agent: "codex", model: "claude-opus-5-5" });
    expect(codex.status).toBe(400);
    expect(codex.json.error).toMatch(/model "claude-opus-5-5" is not a codex model; leave --model off/);
    expect((await api("POST", "/api/v1/runs", { repo, task: "x", agent: "claude", model: "gpt-5-codex" })).status).toBe(400);
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
    expect((await api("POST", `/api/v1/runs/${runId}/stop`)).status).toBe(200);
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
    const queued = await api("POST", `/api/v1/runs/${runId}/clean`);
    expect(queued.status).toBe(202);
    expect(await cleanupResult(`http://127.0.0.1:${daemon!.port}`, queued.json.id)).toEqual({ removed: ["agent"], kept: [] });
    expect(existsSync(run.node.worktree)).toBe(false);
    expect((await git(["branch", "--list", run.node.branch], repo)).trim()).not.toBe("");
  });
});

describe("symlink list", () => {
  it("links an ignored folder into each worktree, and cleaning leaves the real one alone", async () => {
    const { mkdir } = await import("node:fs/promises");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await git(["add", ".gitignore"], repo);
    await git(["commit", "-q", "-m", "ignore deps"], repo);
    await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
    await writeFile(join(repo, "node_modules", "dep", "x.js"), "x");
    await start();
    await setCfg("symlink", "node_modules");
    const runId = await spawn({ files: { "a.txt": "a" }, commit: "a" });
    const run = await settled(runId);
    expect(run.node.status).toBe("done");
    expect(await readFile(join(run.node.worktree, "node_modules", "dep", "x.js"), "utf8")).toBe("x");
    const queued = await api("POST", `/api/v1/runs/${runId}/clean`);
    expect(queued.status).toBe(202);
    await cleanupResult(`http://127.0.0.1:${daemon!.port}`, queued.json.id);
    expect(existsSync(run.node.worktree)).toBe(false);
    expect(await readFile(join(repo, "node_modules", "dep", "x.js"), "utf8")).toBe("x");
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
    expect(seen[0]!.prompt).toMatch(/Before you report done, run "rivet check" and make it pass: it runs the project's check \(node --version\) and tests\./);
    expect(seen[0]!.model).toBe("haiku");
    // With reuse off it is told to run the check itself, as before.
    await setCfg("verify.reuse", "off");
    await settled((await api("POST", "/api/v1/runs", { repo, task: "write a.txt", agent: "claude" })).json.runId);
    expect(seen[1]!.prompt).toMatch(/Before you report done, run the project's check and make it pass: node --version/);
  });
});

describe("rivet check", () => {
  // Every run of the check adds a line to a file outside the worktree.
  async function countingCheck(): Promise<string> {
    const log = join(data, "checks.log");
    await setCfg("check", `node -e "require('fs').appendFileSync(process.argv[1], 'x\\n')" "${log}"`);
    return log;
  }
  const runs = async (log: string) => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

  it("counts as Rivet's own check when the worker finishes on the files it checked", async () => {
    await start();
    const log = await countingCheck();
    const runId = await spawn({ files: { "a.txt": "a" }, stayFor: 1500 });
    await new Promise((r) => setTimeout(r, 500));
    // The work is still uncommitted here; Rivet commits it at done, and the pass still counts.
    expect((await api("POST", `/api/v1/sessions/${runId}-agent/check`)).json).toEqual({ ok: true, output: "check and tests passed" });
    expect((await settled(runId)).node.status).toBe("done");
    expect(await runs(log)).toBe(1);
  });

  it("is checked again when the project turned reuse off", async () => {
    await start();
    const log = await countingCheck();
    await setCfg("verify.reuse", "off");
    const runId = await spawn({ files: { "a.txt": "a" }, stayFor: 1500 });
    await new Promise((r) => setTimeout(r, 500));
    await api("POST", `/api/v1/sessions/${runId}-agent/check`);
    expect((await settled(runId)).node.status).toBe("done");
    expect(await runs(log)).toBe(2);
  });

  it("reports a failure with its output and does not count it", async () => {
    await start();
    await setCfg("check", `node -e "console.log('lint broke'); process.exit(1)"`);
    const runId = await spawn({ files: { "a.txt": "a" }, stayFor: 1500 });
    await new Promise((r) => setTimeout(r, 500));
    const res = (await api("POST", `/api/v1/sessions/${runId}-agent/check`)).json;
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/lint broke/);
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

  it("a worker whose turn ends while its partner works goes on with the partner's result", async () => {
    await start(headless());
    const res = await api("POST", "/api/v1/runs", { repo, task: JSON.stringify({ files: { "w.txt": "w" }, commit: "w", stayFor: 400 }), agent: "claude" });
    const runId = res.json.runId as string;
    expect((await api("POST", `/api/v1/sessions/${runId}-agent/delegate`, { agent: "fake", task: JSON.stringify({ files: { "p.txt": "p" }, stayFor: 1500 }) })).status).toBe(202);
    const run = await settled(runId);
    expect(run.node.status).toBe("done");
    // Resumed with the result, after the partner had finished: its work is in the commits.
    expect(await readFile(join(run.node.worktree, "resumed.txt"), "utf8")).toMatch(/Your partner \(fake\) finished the delegated task/);
    expect(await show(run.node.branch, "p.txt")).toBe("p");
  });

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
    expect((await api("POST", `/api/v1/runs/${orch}/stop`)).status).toBe(200);
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
    expect((await api("POST", `/api/v1/runs/${orch}/stop`)).status).toBe(200);
    expect(errors).toEqual([]);
  });
});

describe("models", () => {
  it("gives each agent only a model meant for it", () => {
    expect(modelFor("claude", { "worker.model": "haiku" })).toBe("haiku");
    expect(modelFor("codex", { "worker.model": "haiku" })).toBeUndefined();
    expect(modelFor("codex", { "worker.model": "haiku", "codex.model": "gpt-5-codex" })).toBe("gpt-5-codex");
    expect(modelFor("codex", { "worker.agent": "codex", "worker.model": "o4" })).toBe("o4");
    expect(modelFor("claude", { "worker.agent": "codex", "worker.model": "o4", "claude.model": "sonnet" })).toBe("sonnet");
    expect(modelFor("claude", { "worker.agent": "codex", "worker.model": "o4" })).toBeUndefined();
  });
});

describe("stopping an orchestrator", () => {
  it("stops the workers it started that still work, unless asked to keep them", async () => {
    await start();
    const orch = async () => (await api("POST", "/api/v1/runs", { repo, task: JSON.stringify({ stayFor: 60_000 }), agent: "fake", role: "orchestrator" })).json.runId as string;
    const first = await orch();
    const working = await spawn({ stayFor: 60_000 }, { from: `${first}-agent` });
    const finished = await spawn({ files: { "f.txt": "f" }, commit: "f" }, { from: `${first}-agent` });
    await settled(finished);
    const stopped = await api("POST", `/api/v1/runs/${first}/stop`, {});
    expect(stopped.json).toEqual({ workers: [working] });
    expect((await getRun(working)).node).toMatchObject({ status: "escalated", summary: `stopped with its orchestrator ${first}` });
    expect((await getRun(finished)).node.status).toBe("done");

    const second = await orch();
    const kept = await spawn({ stayFor: 60_000 }, { from: `${second}-agent` });
    expect((await api("POST", `/api/v1/runs/${second}/stop`, { keepWorkers: true })).json).toEqual({ workers: [] });
    expect((await getRun(kept)).node.status).toBe("running");
    await api("POST", `/api/v1/runs/${kept}/stop`, {});
  });
});

describe("delegating to a partner", () => {
  it("runs the partner in the worker's worktree and hands its result to the worker as a message", async () => {
    await start();
    const worker = await spawn({ listen: true });
    await new Promise((r) => setTimeout(r, 300));
    const partnerTask = JSON.stringify({ files: { "p.txt": "from the partner" }, stayFor: 300 });
    const res = await api("POST", `/api/v1/sessions/${worker}-agent/delegate`, { task: partnerTask });
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ session: `${worker}-partner`, agent: "fake" });
    // One partner at a time.
    expect((await api("POST", `/api/v1/sessions/${worker}-agent/delegate`, { task: partnerTask })).json.error).toMatch(/already has a partner/);
    const worktree = (await getRun(worker)).node.worktree;
    const inbox = join(worktree, "inbox.txt");
    const end = Date.now() + 10_000;
    while (!(existsSync(inbox) && (await readFile(inbox, "utf8")).includes("Your partner")) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(await readFile(inbox, "utf8")).toContain("Your partner (fake) finished the delegated task:");
    // The partner's work is in the worktree, left for the worker's commits.
    expect(await readFile(join(worktree, "p.txt"), "utf8")).toBe("from the partner");
    expect((await git(["status", "--porcelain"], worktree))).toContain("p.txt");
    await api("POST", `/api/v1/runs/${worker}/stop`, {});
  });

  it("is refused for a worker that is not working, and from an orchestrator", async () => {
    await start();
    const done = await spawn({ commit: "none" });
    await settled(done);
    expect((await api("POST", `/api/v1/sessions/${done}-agent/delegate`, { task: "x" })).json.error).toMatch(/is not working/);
    const orch = (await api("POST", "/api/v1/runs", { repo, task: JSON.stringify({ stayFor: 60_000 }), agent: "fake", role: "orchestrator" })).json.runId;
    expect((await api("POST", `/api/v1/sessions/${orch}-agent/delegate`, { task: "x" })).json.error).toMatch(/only a worker delegates/);
    await api("POST", `/api/v1/runs/${orch}/stop`, {});
  });
});

describe("automations", () => {
  it("are saved with their next time, run by hand without moving it, paused and removed", async () => {
    await start();
    const add = await api("POST", "/api/v1/automations", { repo, name: "nightly", cron: "0 2 * * *", zone: "UTC", prompt: JSON.stringify({ files: { "n.txt": "n" }, commit: "n" }), agent: "fake" });
    expect(add.status).toBe(201);
    expect(add.json).toMatchObject({ name: "nightly", enabled: true, role: "worker", nextRunAt: expect.stringMatching(/T02:00:00\.000Z$/) });
    expect((await api("POST", "/api/v1/automations", { repo, name: "nightly", cron: "0 2 * * *", prompt: "x" })).status).toBe(409);
    expect((await api("POST", "/api/v1/automations", { repo, name: "bad", cron: "0 25 * * *", prompt: "x" })).json.error).toMatch(/out of 0-23/);
    const ran = await api("POST", "/api/v1/automations/nightly/run");
    expect((await settled(ran.json.runId)).name).toBe("nightly");
    const listed = (await api("GET", "/api/v1/automations")).json.automations[0];
    expect(listed.nextRunAt).toBe(add.json.nextRunAt);
    expect(listed.runs).toMatchObject([{ runId: ran.json.runId }]);
    expect((await api("POST", "/api/v1/automations/nightly/pause")).json.enabled).toBe(false);
    expect((await api("DELETE", "/api/v1/automations/nightly")).status).toBe(204);
    expect((await api("GET", "/api/v1/automations")).json.automations).toEqual([]);
  });

  it("starts the run of one that came due while the daemon was down, once", async () => {
    const { openStore } = await import("../src/store.js");
    const { realpath } = await import("node:fs/promises");
    const root = await realpath(repo);
    const store = openStore(data);
    store.saveAutomation({
      id: "a1", project: projectOf(root), repo: root, name: "missed", prompt: JSON.stringify({ commit: "none" }), role: "worker", agent: "fake",
      cron: "0 2 * * *", zone: "UTC", enabled: true, nextRunAt: "2026-01-01T02:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.close();
    await start();
    const end = Date.now() + 10_000;
    let a: { nextRunAt: string; runs: { runId?: string }[] };
    do {
      a = (await api("GET", "/api/v1/automations")).json.automations[0];
      if (a.runs.length) break;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < end);
    expect(a.runs).toHaveLength(1);
    expect(Date.parse(a.nextRunAt)).toBeGreaterThan(Date.now());
    await settled(a.runs[0]!.runId!);
  });
});

describe("a task's own spec", () => {
  it("done_when replaces the project's check", async () => {
    await start();
    await setCfg("check", `node -e "process.exit(1)"`);
    const runId = await spawn({ files: { "a.txt": "a" }, commit: "a" }, { spec: { doneWhen: `node -e "process.exit(require('fs').existsSync('a.txt') ? 0 : 1)"` } });
    expect((await settled(runId)).node.status).toBe("done");
  });

  it("work outside the allowed paths goes back, and attempts sets how often", async () => {
    await start();
    const runId = await spawn({ files: { "other.txt": "x" }, commit: "x" }, { spec: { paths: ["src/**"], attempts: 1 } });
    const run = await settled(runId);
    expect(run.node.status).toBe("escalated");
    expect(run.node.summary).toMatch(/gave up after 1 attempts: it changed files outside the allowed paths \(src\/\*\*\): other\.txt/);
  });

  it("a worker past its time limit is stopped and escalated", async () => {
    await start(undefined, { limitMs: 100 });
    const runId = await spawn({ stayFor: 60_000 }, { spec: { minutes: 0.01 } });
    const run = await settled(runId);
    expect(run.node).toMatchObject({ status: "escalated", summary: "stopped: it reached its time limit of 0.01 minutes" });
  });

  it("a bad spec is refused", async () => {
    await start();
    expect((await api("POST", "/api/v1/runs", { repo, task: "x", agent: "fake", spec: { minutes: -2 } })).json.error).toMatch(/must be a positive number/);
  });
});

describe("switching a worker's agent", () => {
  it("stops the running agent and starts the other in the same worktree with a handoff", async () => {
    const seen: string[] = [];
    const fake = getAgent("fake");
    const recording: Agent = {
      ...fake,
      launchCommand: async (cfg) => { seen.push(cfg.prompt ?? ""); return fake.launchCommand({ ...cfg, prompt: JSON.stringify({ stayFor: 60_000 }) }); },
    };
    await start(recording);
    const runId = await spawn({ files: { "w.txt": "w" }, commit: "half done", stayFor: 60_000 });
    await new Promise((r) => setTimeout(r, 500));
    const before = (await getRun(runId)).node.worktree;
    expect((await api("POST", `/api/v1/runs/${runId}/switch`, { agent: "claude", model: "gpt-5" })).json.error).toMatch(/not a claude model/);
    expect((await api("POST", `/api/v1/runs/${runId}/switch`, { agent: "claude" })).status).toBe(202);
    const run = await getRun(runId);
    expect(run.node).toMatchObject({ agent: "claude", status: "running", worktree: before });
    expect(seen[0]).toContain("You take over this task from another agent (fake), in the same worktree, branch and pull request.");
    expect(seen[0]).toMatch(/Commits since the base:\n\w+ half done/);
    expect((await api("GET", `/api/v1/runs/${runId}`)).json.live).toBe(true);
    expect((await api("POST", `/api/v1/runs/${runId}/switch`, { agent: "claude" })).json.error).toMatch(/already runs claude/);
    await api("POST", `/api/v1/runs/${runId}/stop`, {});
  });

  it("waits for a working agent's turn to end, and after stopping one mid-turn clears what it left", async () => {
    const seen: string[] = [];
    const fake = getAgent("fake");
    const recording: Agent = { ...fake, launchCommand: async (cfg) => { seen.push(cfg.prompt ?? ""); return fake.launchCommand({ ...cfg, prompt: JSON.stringify({ stayFor: 60_000 }) }); } };
    await start(recording, { switchWaitMs: 300 });
    const runId = await spawn({ stayFor: 60_000 });
    await new Promise((r) => setTimeout(r, 500));
    // Working, and asking a question: not switched without --now.
    await api("POST", `/api/v1/sessions/${runId}-agent/activity`, { state: "approval", request: { tool: "Bash", detail: "npm publish" } });
    expect((await api("POST", `/api/v1/runs/${runId}/switch`, { agent: "claude" })).json.error).toMatch(/still working.*--now/);
    // Its git was mid-command when stopped.
    const gitDir = (await git(["rev-parse", "--absolute-git-dir"], (await getRun(runId)).node.worktree)).trim();
    await writeFile(join(gitDir, "index.lock"), "");
    await writeFile(join(gitDir, "MERGE_HEAD"), (await git(["rev-parse", "HEAD"], repo)).trim() + "\n");
    expect((await api("POST", `/api/v1/runs/${runId}/switch`, { agent: "claude", now: true })).status).toBe(202);
    expect(existsSync(join(gitDir, "index.lock"))).toBe(false);
    expect(seen[0]).toContain("Its git was stopped mid-command; the lock it left was removed.");
    expect(seen[0]).toContain("A merge is in progress");
    expect((await api("GET", `/api/v1/runs/${runId}`)).json.pendingRequest).toBeUndefined();
    await api("POST", `/api/v1/runs/${runId}/stop`, {});
  });

  it("does not switch a worker that finishes while the switch waits", async () => {
    await start(undefined, { switchWaitMs: 5_000 });
    const runId = await spawn({ stayFor: 60_000 });
    await new Promise((r) => setTimeout(r, 500));
    await api("POST", `/api/v1/sessions/${runId}-agent/activity`, { state: "busy" });
    const switching = api("POST", `/api/v1/runs/${runId}/switch`, { agent: "claude" });
    await new Promise((r) => setTimeout(r, 300));
    await api("POST", "/api/v1/reports", { sessionId: `${runId}-agent`, kind: "done", message: "finished" });
    expect((await switching).json.error).toMatch(/finished its task/);
    expect((await getRun(runId)).node.agent).toBe("fake");
  });

  it("refuses a finished worker", async () => {
    await start();
    const runId = await spawn({ commit: "none" });
    await settled(runId);
    expect((await api("POST", `/api/v1/runs/${runId}/switch`, { agent: "codex" })).json.error).toMatch(/is done/);
  });
});

describe("answering a permission question and send modes", () => {
  // A worker in a terminal that writes every line it gets to inbox.txt.
  async function terminalWorker(): Promise<{ runId: string; inbox: () => Promise<string> }> {
    await start();
    await setCfg("worker.mode", "interactive");
    const runId = await spawn({ listen: true });
    await new Promise((r) => setTimeout(r, 400));
    const worktree = (await getRun(runId)).node.worktree;
    return { runId, inbox: () => readFile(join(worktree, "inbox.txt"), "utf8").catch(() => "") };
  }
  const activity = (runId: string, state: string, request?: object) =>
    api("POST", `/api/v1/sessions/${runId}-agent/activity`, { state, ...(request ? { request } : {}) });
  async function inboxHas(inbox: () => Promise<string>, text: string): Promise<string> {
    const end = Date.now() + 5000;
    while (!(await inbox()).includes(text) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return inbox();
  }

  it("holds messages while the agent is blocked, shows the question, and answers it", async () => {
    const { runId, inbox } = await terminalWorker();
    await activity(runId, "approval", { tool: "PowerShell", detail: "Get-ChildItem | ForEach-Object { $_ }" });
    expect((await api("GET", `/api/v1/runs/${runId}`)).json.pendingRequest).toMatchObject({ tool: "PowerShell", detail: "Get-ChildItem | ForEach-Object { $_ }" });
    // Typed into the question, a message would answer it: it waits.
    expect((await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "also add docs" })).json.delivery).toBe("after-answer");
    expect(await inbox()).not.toContain("also add docs");
    expect((await api("POST", `/api/v1/runs/${runId}/answer`, { choice: "no", note: "use git ls-files instead" })).status).toBe(204);
    const text = await inboxHas(inbox, "also add docs");
    expect(text.split(/\r?\n/).filter(Boolean)).toEqual(["n", "use git ls-files instead", "also add docs"]);
    expect((await api("GET", `/api/v1/runs/${runId}`)).json.pendingRequest).toBeUndefined();
    expect((await api("POST", `/api/v1/runs/${runId}/answer`, { choice: "yes" })).json.error).toMatch(/not waiting for a permission answer/);
    await api("POST", `/api/v1/runs/${runId}/stop`, {});
  });

  it("queue waits for the agent to be idle; steer goes in at once", async () => {
    const { runId, inbox } = await terminalWorker();
    await activity(runId, "busy");
    expect((await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "later please", mode: "queue" })).json.delivery).toBe("when-idle");
    expect((await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "after that", mode: "steer" })).json.delivery).toBe("when-idle");
    expect(await inbox()).toBe("");
    await activity(runId, "idle");
    expect((await inboxHas(inbox, "after that")).split(/\r?\n/).filter(Boolean)).toEqual(["later please", "after that"]);
    expect((await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "now", mode: "bogus" })).status).toBe(400);
    await api("POST", `/api/v1/runs/${runId}/stop`, {});
  });

  it("an answer for an agent without a terminal is refused", async () => {
    await start();
    const runId = await spawn({ listen: true });
    await new Promise((r) => setTimeout(r, 300));
    await activity(runId, "approval");
    expect((await api("POST", `/api/v1/runs/${runId}/answer`, { choice: "yes" })).json.error).toMatch(/only an agent in a terminal/);
    await api("POST", `/api/v1/runs/${runId}/stop`, {});
  });
});

describe("reading a session's timeline", () => {
  it("shows what the worker was told and said; activity adds what it did; pages and cuts like a thread read", async () => {
    await start();
    const runId = await spawn({ listen: true });
    await new Promise((r) => setTimeout(r, 300));
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "also add docs" });
    // What a hook reports: the same prompt again (skipped), a tool call, its result, the reply.
    await api("POST", `/api/v1/sessions/${runId}-agent/activity`, { state: "busy", timeline: [
      { kind: "prompt", text: JSON.stringify({ listen: true }) },
      { kind: "tool", tool: "Bash", text: "npm test" }, { kind: "result", tool: "Bash", text: "ok" },
      { kind: "assistant", text: "x".repeat(30) }, { kind: "nonsense", text: "dropped" },
    ] });
    const messages = (await api("GET", `/api/v1/runs/${runId}/timeline`)).json;
    expect(messages).toMatchObject({ view: "messages", total: 3, run: { id: runId, agent: "fake", status: "running" } });
    expect(messages.items.map((i: { kind: string }) => i.kind)).toEqual(["prompt", "message", "assistant"]);
    const activity = (await api("GET", `/api/v1/runs/${runId}/timeline?view=activity&limit=2`)).json;
    expect(activity.total).toBe(5);
    expect(activity.items.map((i: { kind: string }) => i.kind)).toEqual(["prompt", "message"]);
    const rest = (await api("GET", `/api/v1/runs/${runId}/timeline?view=activity&after=${activity.next}&maxChars=10`)).json;
    expect(rest.items.map((i: { kind: string; text: string }) => [i.kind, i.text])).toEqual([["tool", "npm test"], ["result", "ok"], ["assistant", "xxxxxxxxxx"]]);
    expect(rest.items[2].cut).toEqual({ shown: 10, length: 30 });
    expect(rest.next).toBeUndefined();
    await api("POST", `/api/v1/runs/${runId}/stop`, {});
  });

  it("keeps a headless Claude worker's every reply and call from stream-json, and its hooks add no duplicates", async () => {
    const events = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "Reading the code." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "export {}" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Nothing to change." }] } },
    ];
    const script = `setTimeout(() => { for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e)); }, 600);`;
    const fake = getAgent("fake");
    const claudeLike: Agent = { ...fake, name: "claude", launchCommand: async () => [process.execPath, "-e", script] };
    await start(claudeLike);
    const runId = (await api("POST", "/api/v1/runs", { repo, task: "look at a.ts", agent: "claude" })).json.runId as string;
    await new Promise((r) => setTimeout(r, 200));
    // Its hooks report the same call: dropped, as the stream has it.
    await api("POST", `/api/v1/sessions/${runId}-agent/activity`, { state: "busy", timeline: [{ kind: "tool", tool: "Read", text: "a.ts" }] });
    await settled(runId);
    const items = (await api("GET", `/api/v1/runs/${runId}/timeline?view=activity`)).json.items as { kind: string; tool?: string; text: string }[];
    expect(items.filter((i) => i.kind !== "event").map((i) => [i.kind, i.tool ?? "", i.text])).toEqual([
      ["prompt", "", expect.stringMatching(/^Your task: look at a\.ts/)],
      ["assistant", "", "Reading the code."], ["tool", "Read", "a.ts"], ["result", "Read", "export {}"], ["assistant", "", "Nothing to change."],
    ]);
  });

  it("keeps a headless Codex worker's replies and commands from its --json events, as they come", async () => {
    const script = "for (const e of [" +
      "{type:'item.completed',item:{type:'agent_message',text:'Looking at the tests.'}}," +
      "{type:'item.started',item:{type:'command_execution',command:'npm test'}}," +
      "{type:'item.completed',item:{type:'command_execution',command:'npm test',aggregated_output:'1 passing'}}," +
      "{type:'item.completed',item:{type:'agent_message',text:'All green.'}}]) console.log(JSON.stringify(e));";
    const fake = getAgent("fake");
    const codexLike: Agent = { ...fake, name: "codex", launchCommand: async () => [process.execPath, "-e", script] };
    daemon = await startDaemon({
      data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500, onError: (e) => errors.push(e),
      agents: (name) => (name === "codex" ? codexLike : getAgent("fake")),
    });
    const runId = (await api("POST", "/api/v1/runs", { repo, task: "check the tests", agent: "codex" })).json.runId as string;
    await settled(runId);
    const items = (await api("GET", `/api/v1/runs/${runId}/timeline?view=activity`)).json.items as { kind: string; tool?: string; text: string }[];
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ["prompt", expect.stringMatching(/^Your task: check the tests/)],
      ["assistant", "Looking at the tests."], ["tool", "npm test"], ["result", "1 passing"], ["assistant", "All green."],
      ["event", expect.stringMatching(/./)],
    ].slice(0, items.length));
    expect(items.slice(1, 5).map((i) => i.kind)).toEqual(["assistant", "tool", "result", "assistant"]);
  });
});
