import { existsSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, type Agent } from "../src/agents/agent.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { git } from "../src/git.js";
import { githubClient } from "../src/github/github.js";
import type { Run } from "../src/store.js";

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
  await gh.close();
  for (const d of [repo, origin, data]) await removeRepo(d);
});

let errors: unknown[] = [];
let notices: {title:string;body:string}[] = [];

// What the test reviewer does: stays until the test submits for it, unless changed.
let reviewerScript: object = { stayFor: 60_000 };
let reviewerLaunches: { prompt?: string; permission?: string; allowedTools?: string[] }[] = [];
function reviewerAgent(): Agent {
  const fake = getAgent("fake");
  return {
    ...fake,
    launchCommand: async (cfg) => {
      reviewerLaunches.push({ ...(cfg.prompt !== undefined ? { prompt: cfg.prompt } : {}), ...(cfg.permission ? { permission: cfg.permission } : {}), ...(cfg.allowedTools ? { allowedTools: cfg.allowedTools } : {}) });
      return fake.launchCommand({ ...cfg, prompt: JSON.stringify(reviewerScript) });
    },
  };
}

async function start(config: Record<string, string> = {}, rapid = false): Promise<void> {
  errors = [];
  notices = [];
  daemon = await startDaemon({
    notify: async notice => {notices.push(notice);},
    data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500, prWatchMs: rapid ? 1 : 150, onError: (e) => errors.push(e),
    // "claude" stands for a reviewer here (review.agent): it runs reviewerScript.
    agents: (name) => (name === "claude" ? reviewerAgent() : getAgent("fake")),
    github: async () => { const client=githubClient({ repo: "o/r", token: "t0ken", api: gh.api }); return rapid ? {...client, facts:async(n:number)=>{await new Promise(r=>setTimeout(r,50));return client.facts(n);}} : client; },
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
    expect(pr).toMatchObject({ number: 1, url: "https://github.com/o/r/pull/1" });
    expect(run.node.prStatus).toBe("open");
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

describe("a worker from an issue", () => {
  it("starts with the issue as its task, is named after it, and its pull request closes it", async () => {
    gh.issues[5] = { title: "Add a.txt", state: "open", body: JSON.stringify({ files: { "a.txt": "a" }, commit: "add a" }), labels: [{ name: "feature" }], assignees: [] };
    await start({ pr: "auto" });
    const res = await api("POST", "/api/v1/runs", { repo, issue: "5", agent: "fake" });
    expect(res.status).toBe(201);
    const runId = res.json.runId as string;
    const { run } = await until(() => runOf(runId), (r) => r.pr !== null);
    expect(run.name).toBe("Add a.txt");
    expect(run.task).toMatch(/^Resolve issue #5\.[\s\S]*Labels: feature\n\nBody:\n\{"files"/);
    expect(gh.prs[0]!.title).toBe("Add a.txt");
    expect(gh.prs[0]!.body).toMatch(/Closes #5$/);
  });

  it("refuses an issue it cannot read or of another repository", async () => {
    await start();
    expect((await api("POST", "/api/v1/runs", { repo, issue: "99", agent: "fake" })).json.error).toMatch(/cannot read issue 99/);
    expect((await api("POST", "/api/v1/runs", { repo, issue: "x/y#5", agent: "fake" })).json.error).toMatch(/not in this repository/);
  });
});

describe("watching the pull request", () => {
  async function opened(): Promise<string> {
    await start({ pr: "auto" });
    const runId = await spawn();
    await until(() => runOf(runId), (r) => r.pr !== null);
    return runId;
  }

  it("routes additional linked PR failures once and persists their handled revision", async () => {
    const runId = await opened();
    gh.prs.push({ ...gh.prs[0]!, number: 2, head: { ...gh.prs[0]!.head, sha: "linked-sha" } });
    gh.checks["linked-sha"] = [{ id: 99, status: "completed", conclusion: "failure" }];
    expect((await api("POST", `/api/v1/runs/${runId}/linked-prs`, { number: 2 })).status).toBe(200);
    await until(() => runOf(runId), result => result.run.node.attempts === 2 && result.run.node.status === "done");
    const links = (await api("GET", `/api/v1/runs/${runId}/linked-prs`)).json.linked;
    expect(links[0].handled).toContain("checks-failing");
    await new Promise(resolve => setTimeout(resolve, 500));
    expect((await runOf(runId)).run.node.attempts).toBe(2);
  });
  it("sends a CI failure back to the worker, once", async () => {
    const runId = await opened();
    gh.checks.sha1 = [{ id: 9, status: "completed", conclusion: "failure" }];
    gh.annotations[9] = [{ path: "a.txt" }];
    const { run } = await until(() => runOf(runId), (r) => r.run.node.attempts === 2 && r.run.node.status === "done" && (r.pr?.handled ?? "").startsWith("checks-failing"));
    // Fixed and finished: the CI failure no longer stands on the worker.
    expect(run.node.summary ?? null).toBeNull();
    await new Promise((r) => setTimeout(r, 600));
    expect((await runOf(runId)).run.node.attempts).toBe(2);
  });

  it("leaves reading the failure to the worker unless the project asks Rivet to fetch it", async () => {
    const runId = await opened();
    gh.checks.sha1 = [{ id: 9, status: "completed", conclusion: "failure" }];
    gh.annotations[9] = [{ path: "a.txt" }];
    await until(() => runOf(runId), (r) => (r.pr?.handled ?? "").startsWith("checks-failing"));
    expect(gh.requests.some((r) => r.includes("/annotations"))).toBe(false);
  });

  it("fetches the failing paths itself when pr.feedback is full", async () => {
    await start({ pr: "auto", "pr.feedback": "full" });
    const runId = await spawn();
    await until(() => runOf(runId), (r) => r.pr !== null);
    gh.checks.sha1 = [{ id: 9, status: "completed", conclusion: "failure" }];
    gh.annotations[9] = [{ path: "a.txt" }];
    await until(() => runOf(runId), (r) => (r.pr?.handled ?? "").startsWith("checks-failing"));
    expect(gh.requests.some((r) => r.includes("/check-runs/9/annotations"))).toBe(true);
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
    const after = await until(() => runOf(runId), (r) => r.pr?.handled === "closed");
    expect(after.run.node.prStatus).toBe("closed");
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
    const after = await until(() => runOf(runId), (r) => (r.pr?.handled ?? "").startsWith("closed"));
    expect(after.pr!.handled).toBe("closed; kept agent");
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

describe("the reviewer", () => {
  type Reviewed = { run: Run; reviews: { status: string; verdict?: string; trigger: string; githubReviewId?: number }[] };
  const reviewsOf = async (id: string) => (await api("GET", `/api/v1/runs/${id}`)).json as Reviewed;
  const submit = (runId: string, body: object) => api("POST", `/api/v1/sessions/${runId}-review/review`, body);

  async function reviewed(): Promise<string> {
    reviewerScript = { stayFor: 60_000 };
    reviewerLaunches = [];
    await start({ pr: "auto", review: "auto", "review.agent": "claude" });
    const runId = await spawn();
    await until(() => reviewsOf(runId), (r) => r.reviews.some((v) => v.status === "running"));
    return runId;
  }

  it("starts once the pull request is open, read-only, and sends required changes to the worker", async () => {
    const runId = await reviewed();
    expect(reviewerLaunches[0]).toMatchObject({ permission: "read-only" });
    expect(reviewerLaunches[0]!.allowedTools).toContain("Bash(rivet review submit:*)");
    expect(reviewerLaunches[0]!.allowedTools!.some((t) => /Edit|Write/.test(t))).toBe(false);
    expect((await submit(runId, { verdict: "changes_requested", summary: "one bug", comments: [] })).status).toBe(400);
    const res = await submit(runId, { verdict: "changes_requested", summary: "Off by one.", comments: [{ path: "a.txt", line: 1, body: "use b" }] });
    expect(res.json).toEqual({ githubReviewId: 901 });
    const { run, reviews } = await until(() => reviewsOf(runId), (r) => r.run.node.attempts === 2);
    expect(run.node.summary ?? "").toMatch(/A reviewer asked for changes on pull request #1\. Make each one:\n- a\.txt:1: use b/);
    expect(reviews[0]).toMatchObject({ status: "complete", verdict: "changes_requested", githubReviewId: 901 });
    expect(gh.posted[0]).toMatchObject({ number: 1, event: "COMMENT", commit_id: expect.any(String), comments: [{ path: "a.txt", line: 1, body: "use b" }] });
  });

  it("an approval is posted and the worker is left alone", async () => {
    const runId = await reviewed();
    await submit(runId, { verdict: "approved", summary: "Looks right." });
    await new Promise((r) => setTimeout(r, 500));
    const { run, reviews } = await reviewsOf(runId);
    expect(run.node.attempts).toBe(1);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: "complete", verdict: "approved" });
    expect(gh.posted[0]!.body).toMatch(/ready\.\n\nLooks right\.$/);
  });

  it("a reviewer that exits without submitting fails the pass, and Rivet stops after three tries on one commit", async () => {
    reviewerScript = {};
    reviewerLaunches = [];
    await start({ pr: "auto", review: "auto", "review.agent": "claude" });
    const runId = await spawn();
    const { reviews } = await until(() => reviewsOf(runId), (r) => r.reviews.filter((v) => v.status === "failed").length === 3);
    await new Promise((r) => setTimeout(r, 600));
    expect((await reviewsOf(runId)).reviews).toHaveLength(3);
    expect(reviews.every((v) => v.trigger === "auto")).toBe(true);
  });

  it("rivet review starts one by hand; a second while one runs is refused", async () => {
    reviewerScript = { stayFor: 60_000 };
    await start({ pr: "auto", "review.agent": "claude" });
    const runId = await spawn();
    await until(() => runOf(runId), (r) => r.pr !== null);
    expect((await api("POST", `/api/v1/runs/${runId}/review`)).status).toBe(202);
    expect((await api("POST", `/api/v1/runs/${runId}/review`)).json.error).toMatch(/already running/);
    expect((await reviewsOf(runId)).reviews[0]).toMatchObject({ trigger: "manual", status: "running" });
  });
});

it("coalesces overlapping feedback polls and drains them before closing storage",async()=>{
 await start({pr:"auto","pr.feedback":"full"},true);const runId=await spawn();await until(()=>runOf(runId),r=>r.pr!==null);gh.comments[1]=[{commit_id:"sha1",path:"a.txt",line:1,body:"check the existing behavior"}];await until(()=>runOf(runId),r=>r.run.node.attempts===2);await new Promise(r=>setTimeout(r,300));expect((await runOf(runId)).run.node.attempts).toBe(2);await daemon!.stop();daemon=undefined;expect(errors).toEqual([]);
});
describe("bounded pull request reactions",()=>{
  it("caps CI fixes across new revisions and keeps the cap after restart",async()=>{
    await start({pr:"auto","reactions.ciRetries":"1"});
    const id=await spawn();
    await until(()=>runOf(id),r=>r.pr!==null);
    gh.checks.sha1=[{id:9,status:"completed",conclusion:"failure"}];
    await until(()=>runOf(id),r=>r.run.node.attempts===2 && r.run.node.status==="done");
    gh.prs[0]!.head.sha="sha2";
    gh.checks.sha2=[{id:10,status:"completed",conclusion:"failure"}];
    await until(()=>runOf(id),r=>(r.run.node.summary??"").includes("retry limit"));
    await daemon!.stop();daemon=undefined;await start();
    await new Promise(r=>setTimeout(r,500));
    expect((await runOf(id)).run.node.attempts).toBe(2);
  });
  it("escalates unresolved review changes once after the configured deadline",async()=>{
    await start({pr:"auto","reactions.reviewMinutes":"0.001"});
    const id=await spawn();await until(()=>runOf(id),r=>r.pr!==null);
    gh.comments[1]=[{commit_id:"sha1",path:"a.txt",line:1,body:"change this"}];
    await until(()=>runOf(id),r=>(r.run.node.summary??"").includes("still needs requested"));
    const attempts=(await runOf(id)).run.node.attempts;
    await new Promise(r=>setTimeout(r,500));
    expect((await runOf(id)).run.node.attempts).toBe(attempts);
  });
});

it("notifies approved and passing pull requests once without merging",async()=>{
  await start({pr:"auto"});const id=await spawn();
  await until(()=>runOf(id),r=>r.pr!==null);
  gh.reviews[1]=[{user:{login:"reviewer"},state:"APPROVED"}];
  gh.checks.sha1=[{id:9,status:"completed",conclusion:"success"}];
  await until(async()=>notices,n=>n.some(x=>x.body.includes("approved and green")));
  await new Promise(r=>setTimeout(r,1300));
  expect(notices.filter(n=>n.body.includes("approved and green"))).toHaveLength(1);
  expect(gh.prs[0]!.merged).toBe(false);
});

it("keeps the CI cap when passing checks fail again on the same commit",async()=>{
  await start({pr:"auto","reactions.ciRetries":"1"});
  const id=await spawn();await until(()=>runOf(id),r=>r.pr!==null);
  gh.checks.sha1=[{id:9,status:"completed",conclusion:"failure"}];
  await until(()=>runOf(id),r=>r.run.node.attempts===2&&r.run.node.status==="done"&&(r.pr?.handled??"").startsWith("checks-failing"));
  gh.checks.sha1=[{id:9,status:"completed",conclusion:"success"}];
  await until(()=>runOf(id),r=>!(r.pr?.handled??"").startsWith("checks-failing"));
  gh.checks.sha1=[{id:9,status:"completed",conclusion:"failure"}];
  await until(()=>runOf(id),r=>(r.run.node.summary??"").includes("retry limit"));
  await new Promise(r=>setTimeout(r,500));
  expect((await runOf(id)).run.node.attempts).toBe(2);
});
