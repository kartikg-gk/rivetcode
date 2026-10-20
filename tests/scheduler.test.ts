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

async function start(parentAgent?: Agent, replan?: (prompt: string) => string | null): Promise<void> {
  daemon = await startDaemon({
    ...(replan ? { replan: async (_run, node) => replan(node.prompt) } : {}),
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
    // The first attempt's failure is not left on a finished leaf.
    expect(run.nodes[1]!.summary ?? null).toBeNull();
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

describe("re-plan", () => {
  it("re-plans a leaf that failed twice and gives it one more try", async () => {
    const seen: string[] = [];
    await start(undefined, (prompt) => { seen.push(prompt); return JSON.stringify({ files: { "fixed.txt": "ok" }, commit: "fixed" }); });
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("bad", { exitCode: 3 })] });
    const run = await settled(runId);
    expect(statuses(run)).toEqual({ root: "done", "root.1": "done" });
    expect(run.nodes[1]!.attempts).toBe(3);
    expect(seen).toEqual([JSON.stringify({ exitCode: 3 })]);
    expect(await show(`rivet/${runId}/root`, "fixed.txt")).toBe("ok");
  });

  it("escalates after the re-planned try fails too", async () => {
    await start(undefined, () => JSON.stringify({ exitCode: 4 }));
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("bad", { exitCode: 3 })] });
    const run = await settled(runId);
    expect(run.nodes[1]).toMatchObject({ status: "escalated", attempts: 3 });
  });

  it("escalates at once when the planner has nothing better", async () => {
    await start(undefined, () => null);
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("bad", { exitCode: 3 })] });
    expect((await settled(runId)).nodes[1]).toMatchObject({ status: "escalated", attempts: 2 });
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

describe("active files", () => {
  it("lists files claimed or changed by runs still in flight", async () => {
    await start();
    const runId = await runPlan({ title: "root", prompt: "r", children: [
      { ...leaf("busy", { files: { "src/changed.ts": "x" }, commit: "c", stayFor: 60_000 }), files: ["src/claimed.ts"] },
    ] });
    const tree = (await getRun(runId)).nodes[1]!.worktree;
    const end = Date.now() + 10_000;
    while (Date.now() < end && !(await git(["log", "--oneline", "-1"], tree)).includes(" c")) await new Promise((r) => setTimeout(r, 50));
    const res = await api("GET", `/api/v1/projects/${encodeURIComponent(projectOf(repo))}/active-files`);
    expect(res.json.files).toEqual(expect.arrayContaining([
      { file: "src/claimed.ts", runId, nodeId: "root.1" },
      { file: "src/changed.ts", runId, nodeId: "root.1" },
    ]));
  });
});

describe("copy list", () => {
  it("copies listed ignored files into every worktree and never commits them", async () => {
    await writeFile(join(repo, ".gitignore"), ".env\n");
    await git(["add", ".gitignore"], repo);
    await git(["commit", "-q", "-m", "ignore env"], repo);
    await writeFile(join(repo, ".env"), "SECRET=1\n");
    await start();
    await api("PUT", `/api/v1/projects/${encodeURIComponent(projectOf(repo))}/config`, { key: "copy", value: ".env, missing.txt" });
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("a", { files: { "a.txt": "a" } })] });
    const run = await settled(runId);
    expect(await readFile(join(run.nodes[1]!.worktree, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(run.nodes[0]!.status).toBe("done");
    await expect(show(`rivet/${runId}/root`, ".env")).rejects.toThrow();
  });

  it("refuses to copy a file git does not ignore", async () => {
    await writeFile(join(repo, "notes.txt"), "x");
    await start();
    await api("PUT", `/api/v1/projects/${encodeURIComponent(projectOf(repo))}/config`, { key: "copy", value: "notes.txt" });
    const res = await api("POST", "/api/v1/runs", { repo, task: "t", plan: leaf("a", {}) });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/only takes files git ignores/);
  });
});

describe("worktree setup", () => {
  const setCfg = (key: string, value: string) =>
    api("PUT", `/api/v1/projects/${encodeURIComponent(projectOf(repo))}/config`, { key, value });

  it("runs each setup step in every new worktree before agents start", async () => {
    await start();
    await setCfg("setup", [
      `node -e "require('fs').writeFileSync('step1.txt', process.env.RIVET_WORKTREE_PATH)"`,
      `node -e "require('fs').writeFileSync('step2.txt', require('fs').existsSync('step1.txt') + ' ' + process.env.RIVET_SOURCE_TREE_PATH)"`,
    ].join("\n"));
    await writeFile(join(repo, ".gitignore"), "step*.txt\n");
    await git(["add", ".gitignore"], repo);
    await git(["commit", "-q", "-m", "ignore steps"], repo);
    const runId = await runPlan({ title: "root", prompt: "r", children: [leaf("a", { files: { "a.txt": "a" }, commit: "a" })] });
    const run = await settled(runId);
    for (const n of run.nodes) {
      expect(await readFile(join(n.worktree, "step1.txt"), "utf8")).toBe(n.worktree);
      expect(await readFile(join(n.worktree, "step2.txt"), "utf8")).toBe(`true ${repo}`);
    }
    expect(run.nodes[0]!.status).toBe("done");
  });

  it("refuses the run when a step fails, showing its output, and leaves nothing behind", async () => {
    await start();
    await setCfg("setup", `node -e "console.error('install broke'); process.exit(2)"`);
    const res = await api("POST", "/api/v1/runs", { repo, task: "t", plan: leaf("a", {}) });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/setup step 1 .* failed in root:\s+install broke/);
    expect((await git(["branch", "--list", "rivet/*"], repo)).trim()).toBe("");
    expect(await listWorktrees(repo)).toHaveLength(1);
  });
});

describe("what a leaf may run", () => {
  it("lets a leaf run the check and test commands, and tells it to run the check before done", async () => {
    const seen: { allowedTools?: string[]; prompt?: string }[] = [];
    const fake = getAgent("fake");
    const recording: Agent = {
      ...fake,
      launchCommand: async (cfg) => {
        seen.push({ ...(cfg.allowedTools ? { allowedTools: cfg.allowedTools } : {}), ...(cfg.prompt !== undefined ? { prompt: cfg.prompt } : {}) });
        return fake.launchCommand({ ...cfg, prompt: JSON.stringify({ files: { "a.txt": "a" }, commit: "a" }) });
      },
    };
    await start(recording);
    await api("PUT", `/api/v1/projects/${encodeURIComponent(projectOf(repo))}/config`, { key: "check", value: "node --version" });
    await api("PUT", `/api/v1/projects/${encodeURIComponent(projectOf(repo))}/config`, { key: "test", value: "git --version" });
    const runId = await runPlan({ title: "root", prompt: "r", children: [{ title: "a", prompt: "write a.txt", agent: "claude" }] });
    await settled(runId);
    expect(seen[0]!.allowedTools).toEqual([
      "Bash(rivet:*)", "Bash(git:*)", "Bash(node --version)", "Bash(node --version:*)", "Bash(git --version)", "Bash(git --version:*)",
    ]);
    expect(seen[0]!.prompt).toMatch(/Before you report done, run the project's check and make it pass: node --version/);
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
      // Rivet wraps a claude leaf's prompt; the script is its JSON line.
      launchCommand: async (cfg) => [process.execPath, script, "--", (cfg.prompt ?? "").split(/\r?\n/).find((l) => l.startsWith("{")) ?? "{}"],
      restoreCommand: async (cfg) => [process.execPath, script, "--", JSON.stringify({ files: { "resumed.txt": cfg.prompt ?? "" }, commit: "act on messages" })],
    };
  }

  it("hands queued messages over when its turn ends, before its work is taken; sibling notes are skipped", async () => {
    await start(headless());
    const spec = (files: object, stayFor?: number) => JSON.stringify({ files, commit: "work", ...(stayFor ? { stayFor } : {}) });
    const runId = await runPlan({ title: "root", prompt: "r", children: [
      { title: "quick", prompt: spec({ "q.txt": "q" }), agent: "claude" },
      { title: "slow", prompt: spec({ "s.txt": "s" }, 2500), agent: "claude" },
    ] });
    const sent = await api("POST", `/api/v1/sessions/${runId}-root.2/send`, { message: "also handle empty input" });
    expect(sent.json.delivery).toBe("turn-end");
    const run = await settled(runId);
    expect(run.nodes.map((n) => n.status)).toEqual(["done", "done", "done"]);
    const resumed = await readFile(join(run.nodes[0]!.worktree, "resumed.txt"), "utf8");
    expect(resumed).toMatch(/Messages arrived while you worked on your part:\r?\n- also handle empty input/);
    // The quick sibling finished first, but a headless leaf is not resumed just for that note.
    expect(resumed).not.toMatch(/Note from Rivet/);
  });
});

describe("shared files", () => {
  // The root's fake agent is its wiring script; leaves write their own files only.
  const plan = (wiring: object): PlanNode => ({
    title: "root", prompt: JSON.stringify(wiring), agent: "fake", shared: ["index.txt"],
    children: [leaf("a", { files: { "a.txt": "a" }, commit: "a" }), leaf("b", { files: { "b.txt": "b" }, commit: "b" })],
  });

  it("wires the shared files once every part is merged, without a conflict on the way", async () => {
    await start();
    const runId = await runPlan(plan({ files: { "index.txt": "a\nb\n" }, commit: "wire" }));
    const run = await settled(runId);
    expect(statuses(run)).toEqual({ root: "done", "root.1": "done", "root.2": "done" });
    expect((await git(["show", "HEAD:index.txt"], run.nodes[0]!.worktree)).trim()).toBe("a\nb");
    expect((await git(["log", "--format=%s", "-1"], run.nodes[0]!.worktree)).trim()).toBe("wire");
  });

  it("undoes wiring that changes anything else and hands the parent to the user", async () => {
    await start();
    const runId = await runPlan(plan({ files: { "index.txt": "x", "a.txt": "changed" }, commit: "wire too much" }));
    const run = await settled(runId);
    expect(run.nodes[0]).toMatchObject({ status: "escalated", summary: "wiring changed files that are not shared: a.txt" });
    expect((await git(["show", "HEAD:a.txt"], run.nodes[0]!.worktree)).trim()).toBe("a");
  });
});
