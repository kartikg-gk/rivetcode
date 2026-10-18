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

let errors: unknown[] = [];

async function start(config: Record<string, string> = {}): Promise<void> {
  errors = [];
  daemon = await startDaemon({
    data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500, prWatchMs: 150, onError: (e) => errors.push(e),
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

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const runOf = async (id: string) => (await api("GET", `/api/v1/runs/${id}`)).json as { run: Run; pr: { number: number; url: string; handled?: string } | null; terminateOnPrMerge: boolean };
const onOrigin = (branch: string, file: string) => git(["show", `${branch}:${file}`], origin);

// A worker on the fake agent: its task is the script it runs.
async function spawn(script: object = { files: { "a.txt": "a" }, commit: "add a" }, more: Record<string, unknown> = {}): Promise<string> {
  const res = await api("POST", "/api/v1/runs", { repo, task: JSON.stringify(script), agent: "fake", name: "add a", ...more });
  expect(res.status).toBe(201);
  return res.json.runId;
}

describe("opening the pull request", () => {
  it("pr=auto pushes the finished worker's branch and opens one PR for it", async () => {
    await start({ pr: "auto" });
    const runId = await spawn();
    const { pr, run } = await until(() => runOf(runId), (r) => r.pr !== null);
    expect(pr).toEqual({ number: 1, url: "https://github.com/o/r/pull/1" });
    expect(run.node.prStatus).toBe("pr_open");
    expect(gh.prs[0]).toMatchObject({ title: "add a", base: "main", head: { ref: `rivet/${runId}/agent` } });
    expect(gh.prs[0]!.body).toMatch(/Done by one agent \(fake\) in its own worktree/);
    expect(gh.prs[0]!.body).toMatch(/Files: `a\.txt`/);
    expect((await onOrigin(`rivet/${runId}/agent`, "a.txt")).trim()).toBe("a");
  });

  it("opens nothing on its own without pr=auto, and once on request", async () => {
    await start();
    const runId = await spawn();
    await until(() => runOf(runId), (r) => r.run.node.status === "done");
    await daemon!.idle();
    expect(gh.prs).toHaveLength(0);
    const first = await api("POST", `/api/v1/runs/${runId}/pr`);
    expect(first.status).toBe(200);
    expect((await api("POST", `/api/v1/runs/${runId}/pr`)).json).toEqual(first.json);
    expect(gh.prs).toHaveLength(1);
  });

  it("pulls in a moved base before pushing", async () => {
    await start();
    const runId = await spawn();
    await until(() => runOf(runId), (r) => r.run.node.status === "done");
    await writeFile(join(repo, "main.txt"), "moved");
    await git(["add", "."], repo);
    await git(["commit", "-q", "-m", "main moved"], repo);
    await git(["push", "-q", "origin", "main"], repo);
    expect((await api("POST", `/api/v1/runs/${runId}/pr`)).status).toBe(200);
    expect((await onOrigin(`rivet/${runId}/agent`, "main.txt")).trim()).toBe("moved");
    expect((await onOrigin(`rivet/${runId}/agent`, "a.txt")).trim()).toBe("a");
  });

  it("opens no pull request for work that changed nothing", async () => {
    await start({ pr: "auto" });
    const runId = await spawn({ stayFor: 100 });
    const { run, pr } = await until(() => runOf(runId), (r) => r.run.node.status === "done");
    await daemon!.idle();
    expect(pr).toBeNull();
    expect(run.node.summary).toBe("no changes: main already has what the task asks for");
    expect(gh.prs).toHaveLength(0);
    expect((await api("POST", `/api/v1/runs/${runId}/pr`)).json.error).toMatch(/changed nothing/);
    expect(errors).toEqual([]);
  });

  it("refuses a worker that is not done, and an orchestrator", async () => {
    await start();
    const slow = await spawn({ stayFor: 60_000 });
    expect((await api("POST", `/api/v1/runs/${slow}/pr`)).status).toBe(409);
    const orch = (await api("POST", "/api/v1/runs", { repo, task: JSON.stringify({ stayFor: 60_000 }), agent: "fake", role: "orchestrator" })).json.runId;
    expect((await api("POST", `/api/v1/runs/${orch}/pr`)).json.error).toMatch(/only a worker opens a pull request/);
  });
});

describe("watching the pull request", () => {
  async function opened(): Promise<string> {
    await start({ pr: "auto" });
    const runId = await spawn();
    await until(() => runOf(runId), (r) => r.pr !== null);
    return runId;
  }

  it("sends a CI failure back to the worker, once", async () => {
    const runId = await opened();
    gh.checks.sha1 = [{ id: 9, status: "completed", conclusion: "failure" }];
    gh.annotations[9] = [{ path: "a.txt" }];
    const { run } = await until(() => runOf(runId), (r) => r.run.node.attempts === 2 && r.run.node.status === "done" && (r.pr?.handled ?? "").startsWith("ci_failed"));
    // Fixed and finished: the CI failure no longer stands on the worker.
    expect(run.node.summary ?? null).toBeNull();
    await new Promise((r) => setTimeout(r, 600));
    expect((await runOf(runId)).run.node.attempts).toBe(2);
  });

  it("sends review comments to the worker", async () => {
    const runId = await opened();
    gh.comments[1] = [{ commit_id: "sha1", path: "a.txt", line: 1, body: "please use lowercase" }];
    await until(() => runOf(runId), (r) => r.run.node.attempts === 2);
  });

  it("records a merged pull request and stops acting on it", async () => {
    const runId = await opened();
    gh.prs[0]!.merged = true;
    gh.prs[0]!.state = "closed";
    await until(() => runOf(runId), (r) => r.run.node.prStatus === "merged");
    gh.checks.sha1 = [{ id: 9, status: "completed", conclusion: "failure" }];
    await new Promise((r) => setTimeout(r, 500));
    const { run } = await runOf(runId);
    expect(run.node.prStatus).toBe("merged");
    // A run stays after its merge unless it asked to end.
    expect(existsSync(run.node.worktree)).toBe(true);
  });
});

describe("ending the run after the merge", () => {
  const merge = () => { gh.prs[0]!.merged = true; gh.prs[0]!.state = "closed"; };
  const policy = (runId: string, terminateOnPrMerge: unknown) => api("PATCH", `/api/v1/runs/${runId}/merge-policy`, { terminateOnPrMerge });

  it("terminates a run that asked for it: the worktree goes, the branch stays", async () => {
    await start({ pr: "auto" });
    const runId = await spawn();
    const { run } = await until(() => runOf(runId), (r) => r.pr !== null);
    expect((await runOf(runId)).terminateOnPrMerge).toBe(false);
    expect((await policy(runId, true)).status).toBe(200);
    merge();
    const after = await until(() => runOf(runId), (r) => r.pr?.handled === "terminated");
    expect(after.run.node.prStatus).toBe("terminated");
    expect(existsSync(run.node.worktree)).toBe(false);
    expect((await git(["branch", "--list", run.node.branch], repo)).trim()).not.toBe("");
  });

  it("never forces out a worktree with uncommitted work: it is kept and named, the run still ends", async () => {
    await start({ pr: "auto" });
    const runId = await spawn();
    const { run } = await until(() => runOf(runId), (r) => r.pr !== null);
    await policy(runId, true);
    await writeFile(join(run.node.worktree, "notes.txt"), "not committed");
    merge();
    const after = await until(() => runOf(runId), (r) => (r.pr?.handled ?? "").startsWith("terminated"));
    expect(after.pr!.handled).toBe("terminated; kept agent");
    expect(existsSync(join(run.node.worktree, "notes.txt"))).toBe(true);
  });

  it("takes only true or false", async () => {
    await start({ pr: "auto" });
    const runId = await spawn();
    expect((await policy(runId, "yes")).status).toBe(400);
    expect((await policy("r999", true)).status).toBe(404);
  });
});

describe("radar", () => {
  it("reports workers of a project that would conflict while both still work", async () => {
    await start();
    const one = await spawn({ files: { "s.txt": "one" }, commit: "one", stayFor: 60_000 });
    const two = await spawn({ files: { "s.txt": "two" }, commit: "two", stayFor: 60_000 });
    const project = repo.split(/[\\/]/).pop()!.toLowerCase().replace(/ /g, "-");
    const res = await until(async () => (await api("GET", `/api/v1/projects/${encodeURIComponent(project)}/radar`)).json, (j) => j.conflicts.length > 0);
    expect(res.conflicts).toEqual([{ a: one, b: two, files: ["s.txt"] }]);
  });
});

describe("runs saved before a run was one session", () => {
  it("are left alone by the watcher and on restart", async () => {
    const { openStore } = await import("../src/store.js");
    const { sessionRun } = await import("./helpers.js");
    const store = openStore(data);
    const old = sessionRun(data, { id: "rold", project: "p" });
    store.saveRun({ ...old, repo, node: { ...old.node, id: "root", branch: "rivet/rold/root", status: "done" } });
    store.setPr("rold", { number: 99, url: "https://github.com/o/r/pull/99" });
    store.close();
    await start();
    await new Promise((r) => setTimeout(r, 600));
    expect(errors).toEqual([]);
  });
});
