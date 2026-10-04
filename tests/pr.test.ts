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
    expect(run.nodes[1]!.summary).toMatch(/CI failed on the pull request in: a\.txt/);
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
    expect((await runOf(runId)).run.nodes[0]!.prStatus).toBe("merged");
  });
});
