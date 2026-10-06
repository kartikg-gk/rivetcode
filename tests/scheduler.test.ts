import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, type Agent } from "../src/agents/agent.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { git } from "../src/git.js";
import type { Run } from "../src/store.js";
import type { PlanNode } from "../src/tree.js";
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

// A parent agent that resolves a conflict by writing the given content and committing.
function resolver(content: string | null): Agent {
  const fake = getAgent("fake");
  const script = fileURLToPath(new URL("../src/agents/fake-agent.mjs", import.meta.url));
  return {
    ...fake,
    launchCommand: async () => [process.execPath, script, "--", JSON.stringify(
      content === null ? { exitCode: 1 } : { files: { "shared.txt": content }, commit: "resolve conflict" },
    )],
  };
}

async function start(parentAgent?: Agent): Promise<void> {
  daemon = await startDaemon({
    data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500,
    agents: () => getAgent("fake"),
    ...(parentAgent ? { agents: (name) => (name === "claude" ? parentAgent : getAgent("fake")) } : {}),
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

const leaf = (title: string, spec: object): PlanNode => ({ title, prompt: JSON.stringify(spec), agent: "fake" });

async function runPlan(plan: PlanNode, task = "build it"): Promise<string> {
  const res = await api("POST", "/api/v1/runs", { repo, task, plan });
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
    const root = run.nodes[0]!;
    // A finished leaf waiting for its parent is not busy; neither is a parent waiting on the user.
    const busy = run.nodes.some((n) => (n.status === "running" && !n.finishedAt) || n.status === "integrating");
    if (["done", "failed", "escalated"].includes(root.status) && !busy) {
      await daemon!.idle();
      return getRun(runId);
    }
    if (!busy && run.nodes.some((n) => n.status === "escalated")) {
      await daemon!.idle();
      return getRun(runId);
    }
    if (Date.now() > end) throw new Error(`run did not settle: ${JSON.stringify(run.nodes.map((n) => [n.id, n.status, n.summary]))}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const statuses = (run: Run) => Object.fromEntries(run.nodes.map((n) => [n.id, n.status]));
const show = async (branch: string, file: string) => git(["show", `${branch}:${file}`], repo);

describe("creating a run", () => {
  it("makes a worktree per node, children branching from their parent", async () => {
    await start();
    const runId = await runPlan({
      title: "root", prompt: "r", children: [leaf("a", { stayFor: 5000 }), leaf("b", { stayFor: 5000 })],
    });
    const run = await getRun(runId);
    expect(run.nodes.map((n) => n.branch)).toEqual([`rivet/${runId}/root`, `rivet/${runId}/root.1`, `rivet/${runId}/root.2`]);
    const paths = (await listWorktrees(repo)).map((w) => w.branch);
    expect(paths).toEqual(expect.arrayContaining(run.nodes.map((n) => n.branch)));
    expect(statuses(run)).toEqual({ root: "waiting", "root.1": "running", "root.2": "running" });
  });

  it("rejects bad input without leaving anything behind", async () => {
    await start();
    expect((await api("POST", "/api/v1/runs", { repo: data, task: "t", plan: { title: "x", prompt: "y" } })).status).toBe(400);
    expect((await api("POST", "/api/v1/runs", { repo, task: "t", plan: { title: "", prompt: "y" } })).status).toBe(400);
    expect((await api("POST", "/api/v1/runs", { repo, task: "t", base: "nope", plan: { title: "x", prompt: "y" } })).status).toBe(400);
    expect(await listWorktrees(repo)).toHaveLength(1);
    expect((await git(["branch", "--list", "rivet/*"], repo)).trim()).toBe("");
  });
});

describe("incremental merge", () => {
  it("merges each finished leaf into its parent and finishes the root", async () => {
    await start();
    const runId = await runPlan({
      title: "root", prompt: "r", children: [
        leaf("a", { files: { "a.txt": "a\n" }, commit: "add a" }),
        leaf("b", { files: { "b.txt": "b\n" }, commit: "add b", stayFor: 300 }),
      ],
    });
    const run = await settled(runId);
    expect(statuses(run)).toEqual({ root: "done", "root.1": "done", "root.2": "done" });
    expect(await show(`rivet/${runId}/root`, "a.txt")).toBe("a\n");
    expect(await show(`rivet/${runId}/root`, "b.txt")).toBe("b\n");
    expect((await git(["log", "--format=%s", `rivet/${runId}/root`], repo))).toMatch(/Merge "a" \(root\.1\)[\s\S]*|Merge "b"/);
    // main is untouched until a PR lands.
    expect((await git(["ls-tree", "--name-only", "main"], repo)).trim()).toBe("README.txt");
  });

  it("saves work an agent forgot to commit", async () => {
    await start();
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("a", { files: { "a.txt": "x" } })] });
    const run = await settled(runId);
    expect(run.nodes[0]!.status).toBe("done");
    expect(await show(`rivet/${runId}/root`, "a.txt")).toBe("x");
  });

  it("merges three levels bottom up", async () => {
    await start();
    const runId = await runPlan({
      title: "root", prompt: "r", children: [
        { title: "api", prompt: "p", children: [
          leaf("routes", { files: { "routes.txt": "r" }, commit: "routes" }),
          leaf("models", { files: { "models.txt": "m" }, commit: "models" }),
        ] },
        leaf("docs", { files: { "docs.txt": "d" }, commit: "docs" }),
      ],
    });
    const run = await settled(runId);
    expect(statuses(run)).toEqual({ root: "done", "root.1": "done", "root.1.1": "done", "root.1.2": "done", "root.2": "done" });
    for (const f of ["routes.txt", "models.txt", "docs.txt"]) expect(await show(`rivet/${runId}/root`, f)).toBeTruthy();
  });

  it("runs a single-leaf run as just the root", async () => {
    await start();
    const runId = await runPlan(leaf("solo", { files: { "s.txt": "s" }, commit: "solo" }));
    const run = await settled(runId);
    expect(statuses(run)).toEqual({ root: "done" });
  });

  it("tells running siblings when one is merged", async () => {
    await start();
    const runId = await runPlan({
      title: "root", prompt: "r", children: [
        leaf("fast", { files: { "f.txt": "f" }, commit: "fast" }),
        leaf("slow", { listen: true }),
      ],
    });
    const slowTree = (await getRun(runId)).nodes[2]!.worktree;
    const inbox = join(slowTree, "inbox.txt");
    const end = Date.now() + 10_000;
    while (!existsSync(inbox) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(await readFile(inbox, "utf8")).toMatch(/"fast" is finished and merged/);
    await api("POST", `/api/v1/sessions/${runId}-root.2/send`, { message: "/exit" });
    const run = await settled(runId);
    expect(run.nodes[0]!.status).toBe("done");
  });
});

describe("failures", () => {
  it("retries a failing leaf once and then escalates it", async () => {
    await start();
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("bad", { exitCode: 3 })] });
    const run = await settled(runId);
    expect(run.nodes[1]).toMatchObject({ status: "escalated", attempts: 2 });
    expect(run.nodes[1]!.summary).toMatch(/gave up after 2 attempts: agent exited with code 3/);
    expect(run.nodes[0]!.status).toBe("waiting");
  });

  it("a leaf that fails once and then succeeds is merged", async () => {
    await start();
    const runId = await runPlan({
      title: "root", prompt: "r", children: [leaf("flaky", { failUntilAttempt: 2, files: { "f.txt": "f" }, commit: "f" })],
    });
    const run = await settled(runId);
    expect(statuses(run)).toEqual({ root: "done", "root.1": "done" });
    expect(run.nodes[1]!.attempts).toBe(2);
  });

  it("undoes a merge that breaks the check and retries the leaf", async () => {
    await start();
    await api("PUT", `/api/v1/projects/${encodeURIComponent(projectOf(repo))}/config`, {
      key: "check", value: `node -e "process.exit(require('fs').existsSync('bad.txt') ? 1 : 0)"`,
    });
    const runId = await runPlan({
      title: "root", prompt: "r", children: [
        leaf("good", { files: { "good.txt": "g" }, commit: "good" }),
        leaf("breaks", { files: { "bad.txt": "b" }, commit: "bad" }),
      ],
    });
    const run = await settled(runId);
    expect(run.nodes[2]).toMatchObject({ status: "escalated", attempts: 2 });
    expect(run.nodes[2]!.summary).toMatch(/check .* failed after merging "breaks"/);
    expect(run.nodes[1]!.status).toBe("done");
    await expect(show(`rivet/${runId}/root`, "bad.txt")).rejects.toThrow();
    expect(await show(`rivet/${runId}/root`, "good.txt")).toBe("g");
  });

  it("fails the root when the full test fails", async () => {
    await start();
    await api("PUT", `/api/v1/projects/${encodeURIComponent(projectOf(repo))}/config`, { key: "test", value: `node -e "process.exit(1)"` });
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("a", { files: { "a.txt": "a" }, commit: "a" })] });
    const run = await settled(runId);
    expect(run.nodes[0]!.status).toBe("failed");
    expect(run.nodes[0]!.summary).toMatch(/tests .* failed/);
  });
});

describe("conflicts", () => {
  const conflicting = (): PlanNode => ({
    title: "root", prompt: "r", agent: "claude", children: [
      leaf("one", { files: { "shared.txt": "one\n" }, commit: "one" }),
      leaf("two", { files: { "shared.txt": "two\n" }, commit: "two", stayFor: 400 }),
    ],
  });

  it("lets the parent's agent resolve and merges", async () => {
    await start(resolver("one and two\n"));
    const runId = await runPlan(conflicting());
    const run = await settled(runId);
    expect(statuses(run)).toEqual({ root: "done", "root.1": "done", "root.2": "done" });
    expect(await show(`rivet/${runId}/root`, "shared.txt")).toBe("one and two\n");
  });

  it("escalates the parent when its agent cannot resolve, leaving its worktree clean", async () => {
    await start(resolver(null));
    const runId = await runPlan(conflicting());
    const run = await settled(runId);
    expect(run.nodes[0]!.status).toBe("escalated");
    expect(run.nodes[0]!.summary).toMatch(/conflicts in shared\.txt/);
    expect((await git(["status", "--porcelain"], run.nodes[0]!.worktree)).trim()).toBe("");
    expect(await show(`rivet/${runId}/root`, "shared.txt")).toBe("one\n");
  });
});

describe("report --done", () => {
  it("stops the agent and takes its work", async () => {
    await start();
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("a", { files: { "a.txt": "a" }, commit: "a", stayFor: 60_000 })] });
    const tree = (await getRun(runId)).nodes[1]!.worktree;
    const end = Date.now() + 10_000;
    while (!existsSync(join(tree, "a.txt")) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    expect((await api("POST", "/api/v1/reports", { sessionId: `${runId}-root.1`, kind: "done", message: "ok" })).status).toBe(201);
    const run = await settled(runId);
    expect(statuses(run)).toEqual({ root: "done", "root.1": "done" });
  });
});

describe("resume and recovery", () => {
  it("resume retries an escalated leaf after the user fixed things", async () => {
    await start();
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("a", { failUntilAttempt: 3, files: { "a.txt": "a" }, commit: "a" })] });
    let run = await settled(runId);
    expect(run.nodes[1]!.status).toBe("escalated");
    expect((await api("POST", `/api/v1/runs/${runId}/resume`)).status).toBe(202);
    run = await settled(runId);
    expect(statuses(run)).toEqual({ root: "done", "root.1": "done" });
  });

  it("a restarted daemon finishes a run that was in flight", async () => {
    await start();
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("a", { files: { "a.txt": "a" }, commit: "a", stayFor: 60_000 })] });
    await daemon!.stop();
    daemon = undefined;
    // On restart the leaf is relaunched with the same script; make it quick this time.
    await start();
    const run = await getRun(runId);
    expect(run.nodes[1]!.status).toBe("running");
    await api("POST", "/api/v1/reports", { sessionId: `${runId}-root.1`, kind: "done", message: "ok" });
    expect((await settled(runId)).nodes[0]!.status).toBe("done");
  });
});

describe("clean", () => {
  it("removes clean worktrees, keeps branches and dirty worktrees", async () => {
    await start();
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("a", { files: { "a.txt": "a" }, commit: "a" })] });
    const run = await settled(runId);
    await writeFile(join(run.nodes[1]!.worktree, "unsaved.txt"), "keep me");
    const res = await api("POST", `/api/v1/runs/${runId}/clean`);
    expect(res.json).toEqual({ removed: ["root"], kept: ["root.1"] });
    expect(existsSync(join(run.nodes[1]!.worktree, "unsaved.txt"))).toBe(true);
    expect((await git(["branch", "--list", `rivet/${runId}/*`], repo)).trim().split("\n")).toHaveLength(2);
  });
});

function projectOf(dir: string): string {
  return dir.split(/[\\/]/).pop()!.toLowerCase().trim().replace(/ /g, "-");
}
