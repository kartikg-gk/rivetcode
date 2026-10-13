import { existsSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/agents/agent.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { git } from "../src/git.js";
import { githubClient } from "../src/github/github.js";
import type { Run } from "../src/store.js";
import type { PlanNode } from "../src/tree.js";
import { waitForTrash } from "../src/worktree.js";
import { mockGitHub, type MockGitHub } from "./github-mock.js";
import { makeDataDir, makeRepo, removeRepo } from "./helpers.js";

let repo: string;
let origin: string;
let data: string;
let gh: MockGitHub;
let daemon: Daemon | undefined;

beforeEach(async () => {
  repo = await makeRepo();
  origin = await realpath(await mkdtemp(join(tmpdir(), "rivet origin ")));
  await git(["init", "-q", "--bare", "-b", "main"], origin);
  await git(["remote", "add", "origin", origin], repo);
  await git(["push", "-q", "origin", "main"], repo);
  data = await makeDataDir();
  gh = await mockGitHub();
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await waitForTrash();
  await gh.close();
  for (const d of [repo, origin, data]) await removeRepo(d);
});

async function start(config: Record<string, string> = {}): Promise<void> {
  daemon = await startDaemon({
    data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500, prWatchMs: 150,
    agents: () => getAgent("fake"),
    github: async () => githubClient({ repo: "o/r", token: "t0ken", api: gh.api }),
  });
  const project = repo.split(/[\\/]/).pop()!.toLowerCase().replace(/ /g, "-");
  for (const [key, value] of Object.entries(config)) await api("PUT", `/api/v1/projects/${encodeURIComponent(project)}/config`, { key, value });
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${daemon!.port}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const leaf = (title: string, spec: object, files?: string[]): PlanNode => ({ title, prompt: JSON.stringify(spec), agent: "fake", ...(files ? { files } : {}) });
const twoParts = (): PlanNode => ({ title: "root", prompt: "r", children: [
  leaf("part a", { files: { "a.txt": "a" }, commit: "a" }, ["a.txt"]),
  leaf("part b", { files: { "b.txt": "b" }, commit: "b" }, ["b.txt"]),
] });

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const runOf = async (id: string) => (await api("GET", `/api/v1/runs/${id}`)).json as { run: Run; pr: { number: number; url: string; handled?: string } | null };
const onOrigin = (branch: string, file: string) => git(["show", `${branch}:${file}`], origin);

async function startRun(plan: PlanNode): Promise<string> {
  const res = await api("POST", "/api/v1/runs", { repo, task: "add parts a and b", plan });
  expect(res.status).toBe(201);
  return res.json.runId;
}

describe("opening the pull request", () => {
  it("pr=auto pushes the finished root and opens one PR listing every part", async () => {
    await start({ pr: "auto" });
    const runId = await startRun(twoParts());
    const { pr, run } = await until(() => runOf(runId), (r) => r.pr !== null);
    expect(pr).toEqual({ number: 1, url: "https://github.com/o/r/pull/1" });
    expect(run.nodes[0]!.prStatus).toBe("pr_open");
    expect(gh.prs[0]).toMatchObject({ title: "add parts a and b", base: "main", head: { ref: `rivet/${runId}/root` } });
    expect(gh.prs[0]!.body).toMatch(/\*\*part a\*\* \(`root\.1`, branch `rivet\/.+\/root\.1`\)/);
    expect(gh.prs[0]!.body).toMatch(/files: `b\.txt`/);
    expect(await onOrigin(`rivet/${runId}/root`, "a.txt")).toBe("a");
  });

  it("opens nothing on its own without pr=auto, and once on request", async () => {
    await start();
    const runId = await startRun(twoParts());
    await until(() => runOf(runId), (r) => r.run.nodes[0]!.status === "done");
    await daemon!.idle();
    expect(gh.prs).toHaveLength(0);
    const first = await api("POST", `/api/v1/runs/${runId}/pr`);
    expect(first.status).toBe(200);
    expect((await api("POST", `/api/v1/runs/${runId}/pr`)).json).toEqual(first.json);
    expect(gh.prs).toHaveLength(1);
  });

  it("pulls in a moved base before pushing", async () => {
    await start();
    const runId = await startRun(twoParts());
    await until(() => runOf(runId), (r) => r.run.nodes[0]!.status === "done");
    await writeFile(join(repo, "main.txt"), "moved");
    await git(["add", "."], repo);
    await git(["commit", "-q", "-m", "main moved"], repo);
    await git(["push", "-q", "origin", "main"], repo);
    expect((await api("POST", `/api/v1/runs/${runId}/pr`)).status).toBe(200);
    expect(await onOrigin(`rivet/${runId}/root`, "main.txt")).toBe("moved");
    expect(await onOrigin(`rivet/${runId}/root`, "a.txt")).toBe("a");
  });

  it("refuses a run that is not done", async () => {
    await start();
    const runId = await startRun({ title: "root", prompt: "r", children: [leaf("slow", { stayFor: 60_000 })] });
    expect((await api("POST", `/api/v1/runs/${runId}/pr`)).status).toBe(409);
  });
});

describe("watching the pull request", () => {
  async function opened(): Promise<string> {
    await start({ pr: "auto" });
    const runId = await startRun(twoParts());
    await until(() => runOf(runId), (r) => r.pr !== null);
    return runId;
  }

  it("sends a CI failure back to the leaf that owns the failing file", async () => {
    const runId = await opened();
    gh.checks.sha1 = [{ id: 9, status: "completed", conclusion: "failure" }];
    gh.annotations[9] = [{ path: "a.txt" }];
    const { run } = await until(() => runOf(runId), (r) => r.run.nodes[1]!.attempts === 2 && r.run.nodes[0]!.status === "done" && (r.pr?.handled ?? "").startsWith("ci_failed"));
    // Fixed and finished: the CI failure no longer stands on the leaf.
    expect(run.nodes[1]!.summary ?? null).toBeNull();
    expect(run.nodes[2]!.attempts).toBe(1);
    // Fixed once; the same failure is not acted on again.
    await new Promise((r) => setTimeout(r, 600));
    expect((await runOf(runId)).run.nodes[1]!.attempts).toBe(2);
  });

  it("sends review comments to the leaf that owns the file", async () => {
    const runId = await opened();
    gh.comments[1] = [{ commit_id: "sha1", path: "b.txt", line: 1, body: "please use lowercase" }];
    const { run } = await until(() => runOf(runId), (r) => r.run.nodes[2]!.attempts === 2);
    expect(run.nodes[2]!.summary).toMatch(/b\.txt:1: please use lowercase/);
    expect(run.nodes[1]!.attempts).toBe(1);
  });

  it("records a merged pull request and stops acting on it", async () => {
    const runId = await opened();
    gh.prs[0]!.merged = true;
    gh.prs[0]!.state = "closed";
    await until(() => runOf(runId), (r) => r.run.nodes[0]!.prStatus === "merged");
    gh.checks.sha1 = [{ id: 9, status: "completed", conclusion: "failure" }];
    await new Promise((r) => setTimeout(r, 500));
    const { run } = await runOf(runId);
    expect(run.nodes[0]!.prStatus).toBe("merged");
    // A run stays after its merge unless it asked to end.
    expect(run.nodes.every((n) => existsSync(n.worktree))).toBe(true);
  });
});

describe("ending the run after the merge", () => {
  const merge = () => { gh.prs[0]!.merged = true; gh.prs[0]!.state = "closed"; };
  const policy = (runId: string, terminateOnPrMerge: unknown) => api("PATCH", `/api/v1/runs/${runId}/merge-policy`, { terminateOnPrMerge });

  it("terminates a run that asked for it: worktrees go, branches stay", async () => {
    await start({ pr: "auto" });
    const runId = await startRun(twoParts());
    const { run } = await until(() => runOf(runId), (r) => r.pr !== null);
    expect((await runOf(runId) as any).terminateOnPrMerge).toBe(false);
    expect((await policy(runId, true)).status).toBe(200);
    expect((await runOf(runId) as any).terminateOnPrMerge).toBe(true);
    merge();
    const after = await until(() => runOf(runId), (r) => r.pr?.handled === "terminated");
    expect(after.run.nodes[0]!.prStatus).toBe("terminated");
    expect(run.nodes.some((n) => existsSync(n.worktree))).toBe(false);
    for (const n of run.nodes) expect((await git(["branch", "--list", n.branch], repo)).trim()).not.toBe("");
  });

  it("never forces out a worktree with uncommitted work: it is kept and named, the run still ends", async () => {
    await start({ pr: "auto" });
    const runId = await startRun(twoParts());
    const { run } = await until(() => runOf(runId), (r) => r.pr !== null);
    await policy(runId, true);
    const dirty = run.nodes[2]!;
    await writeFile(join(dirty.worktree, "notes.txt"), "not committed");
    merge();
    const after = await until(() => runOf(runId), (r) => (r.pr?.handled ?? "").startsWith("terminated"));
    expect(after.pr!.handled).toBe(`terminated; kept ${dirty.id}`);
    expect(after.run.nodes[0]!.prStatus).toBe("terminated");
    expect(existsSync(join(dirty.worktree, "notes.txt"))).toBe(true);
    expect(existsSync(run.nodes[1]!.worktree)).toBe(false);
  });

  it("takes only true or false", async () => {
    await start({ pr: "auto" });
    const runId = await startRun(twoParts());
    expect((await policy(runId, "yes")).status).toBe(400);
    expect((await policy("r999", true)).status).toBe(404);
  });
});

describe("sync", () => {
  it("brings a finished sibling's work into a running leaf", async () => {
    await start();
    const runId = await startRun({ title: "root", prompt: "r", children: [
      leaf("fast", { files: { "a.txt": "a" }, commit: "a" }),
      leaf("slow", { files: { "b.txt": "b" }, commit: "b", stayFor: 60_000 }),
    ] });
    const slow = await until(() => runOf(runId), (r) => r.run.nodes[1]!.status === "done");
    const res = await api("POST", `/api/v1/sessions/${runId}-root.2/sync`, {});
    expect(res.json).toMatchObject({ synced: true, conflicts: [] });
    expect(await git(["show", "HEAD:a.txt"], slow.run.nodes[2]!.worktree)).toBe("a");
  });

  it("undoes a conflicting sync for an agent that cannot be told, and leaves it for an agent that asked", async () => {
    await start();
    const runId = await startRun({ title: "root", prompt: "r", children: [
      leaf("one", { files: { "s.txt": "one" }, commit: "one" }),
      leaf("two", { files: { "s.txt": "two" }, commit: "two", stayFor: 60_000 }),
    ] });
    const { run } = await until(() => runOf(runId), (r) => r.run.nodes[1]!.status === "done");
    const tree = run.nodes[2]!.worktree;
    await until(() => git(["log", "--format=%s", "-1"], tree), (s) => s.trim() === "two");
    // The fake agent listens on stdin, so it is told; make it one that cannot be.
    const told = await api("POST", `/api/v1/sessions/${runId}-root.2/sync`, {});
    expect(told.json).toMatchObject({ synced: false, conflicts: ["s.txt"] });
    if (/undone/.test(told.json.note)) expect((await git(["status", "--porcelain"], tree)).trim()).toBe("");
    else await git(["merge", "--abort"], tree);
    const self = await api("POST", `/api/v1/sessions/${runId}-root.2/sync`, { byAgent: true });
    expect(self.json).toMatchObject({ synced: false, conflicts: ["s.txt"], note: expect.stringMatching(/resolve/) });
    expect((await git(["diff", "--name-only", "--diff-filter=U"], tree)).trim()).toBe("s.txt");
  });
});

describe("ship without a leaf", () => {
  it("finishes the run without a skipped leaf, then opens a follow-up PR when it finishes", async () => {
    await start({ pr: "auto" });
    const runId = await startRun({ title: "root", prompt: "r", children: [
      leaf("quick", { files: { "a.txt": "a" }, commit: "a" }),
      leaf("late", { files: { "late.txt": "late" }, commit: "late", listen: true }),
    ] });
    await until(() => runOf(runId), (r) => r.run.nodes[1]!.status === "done");
    expect((await api("POST", `/api/v1/runs/${runId}/skip`, { node: "root.2" })).status).toBe(204);
    const shipped = await until(() => runOf(runId), (r) => r.pr !== null);
    expect(shipped.run.nodes[0]!.status).toBe("done");
    expect(shipped.run.nodes[2]).toMatchObject({ status: "skipped" });
    await expect(onOrigin(`rivet/${runId}/root`, "late.txt")).rejects.toThrow();
    // The late leaf finishes now.
    await api("POST", `/api/v1/sessions/${runId}-root.2/send`, { message: "/exit" });
    const after = await until(() => runOf(runId), (r) => /follow-up pull request/.test(r.run.nodes[2]!.summary ?? ""));
    expect(after.run.nodes[2]!.summary).toMatch(/pull\/2/);
    expect(gh.prs[1]).toMatchObject({ title: "Follow-up: late", head: { ref: `rivet/${runId}/root.2` } });
    expect(await onOrigin(`rivet/${runId}/root.2`, "a.txt")).toBe("a");
  });

  it("does not end a merged run while a skipped leaf still works toward its follow-up", async () => {
    await start({ pr: "auto" });
    const runId = await startRun({ title: "root", prompt: "r", children: [
      leaf("quick", { files: { "a.txt": "a" }, commit: "a" }),
      leaf("late", { files: { "late.txt": "late" }, commit: "late", listen: true }),
    ] });
    await until(() => runOf(runId), (r) => r.run.nodes[1]!.status === "done");
    await api("POST", `/api/v1/runs/${runId}/skip`, { node: "root.2" });
    await until(() => runOf(runId), (r) => r.pr !== null);
    await api("PATCH", `/api/v1/runs/${runId}/merge-policy`, { terminateOnPrMerge: true });
    gh.prs[0]!.merged = true;
    gh.prs[0]!.state = "closed";
    await until(() => runOf(runId), (r) => r.run.nodes[0]!.prStatus === "merged");
    await new Promise((r) => setTimeout(r, 600));
    const waiting = await runOf(runId);
    expect(waiting.run.nodes[0]!.prStatus).toBe("merged");
    expect((waiting as any).live["root.2"]).toBe(true);
    // Once the late leaf finishes, its follow-up opens and only then does the run end.
    await api("POST", `/api/v1/sessions/${runId}-root.2/send`, { message: "/exit" });
    const after = await until(() => runOf(runId), (r) => r.pr?.handled === "terminated");
    expect(after.run.nodes[2]!.summary).toMatch(/follow-up pull request/);
    expect(gh.prs[1]).toMatchObject({ title: "Follow-up: late" });
  });

  it("only skips leaves that are not finished", async () => {
    await start();
    const runId = await startRun(twoParts());
    await until(() => runOf(runId), (r) => r.run.nodes[0]!.status === "done");
    expect((await api("POST", `/api/v1/runs/${runId}/skip`, { node: "root.1" })).status).toBe(409);
    expect((await api("POST", `/api/v1/runs/${runId}/skip`, { node: "root" })).status).toBe(409);
  });
});

describe("radar endpoint", () => {
  it("reports siblings that would conflict while both still work", async () => {
    await start();
    const runId = await startRun({ title: "root", prompt: "r", children: [
      leaf("one", { files: { "s.txt": "one" }, commit: "one", stayFor: 60_000 }),
      leaf("two", { files: { "s.txt": "two" }, commit: "two", stayFor: 60_000 }),
    ] });
    const res = await until(async () => (await api("GET", `/api/v1/runs/${runId}/radar`)).json, (j) => j.conflicts.length > 0);
    expect(res.conflicts).toEqual([{ a: "root.1", b: "root.2", files: ["s.txt"] }]);
  });
});
