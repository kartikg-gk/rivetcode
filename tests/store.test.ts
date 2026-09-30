import { readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import { assertId } from "../src/paths.js";
import { listRuns, loadRun, newRunId, runFile, RunStoreError, saveRun, type Run } from "../src/store.js";
import { buildTree, setStatus } from "../src/tree.js";
import { makeRepo, removeRepo } from "./helpers.js";

let repo: string;
beforeEach(async () => { repo = await makeRepo(); });
afterEach(async () => { await removeRepo(repo); });

function sampleRun(id = "r1"): Run {
  const nodes = buildTree({
    runId: id, repo, defaultAgent: "claude",
    plan: { title: "r", prompt: "p", children: [{ title: "a", prompt: "do a" }] },
  });
  return { version: 1, id, repo, base: "main", task: "add login", createdAt: "2026-09-30T10:00:00.000Z", nodes };
}

describe("newRunId", () => {
  it("is a valid, unique run id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRunId(1_790_000_000_000)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(() => assertId("run", id)).not.toThrow();
  });
});

describe("saveRun / loadRun", () => {
  it("round-trips a run", async () => {
    const run = sampleRun();
    await saveRun(run);
    expect(await loadRun(repo, "r1")).toEqual(run);
    expect(runFile(repo, "r1")).toBe(join(repo, ".rivet", "runs", "r1.json"));
  });

  it("overwrites with the latest state and leaves no temp files", async () => {
    const run = sampleRun();
    await saveRun(run);
    await saveRun({ ...run, nodes: setStatus(run.nodes, "root.1", "running") });
    expect((await loadRun(repo, "r1")).nodes[1]!.status).toBe("running");
    expect(await readdir(dirname(runFile(repo, "r1")))).toEqual(["r1.json"]);
  });

  it("ignores a temp file left by a crash mid-save", async () => {
    await saveRun(sampleRun());
    await writeFile(`${runFile(repo, "r1")}.123.abcd.tmp`, '{"version":1,"id":"r1","nodes":[');
    expect((await loadRun(repo, "r1")).task).toBe("add login");
    expect(await listRuns(repo)).toEqual(["r1"]);
  });

  it("names the file when it is not valid JSON", async () => {
    await saveRun(sampleRun());
    await writeFile(runFile(repo, "r1"), '{"version":1,');
    await expect(loadRun(repo, "r1")).rejects.toThrow(RunStoreError);
    await expect(loadRun(repo, "r1")).rejects.toThrow(/r1\.json/);
  });

  it("rejects a file with the wrong shape", async () => {
    await saveRun(sampleRun());
    await writeFile(runFile(repo, "r1"), JSON.stringify({ version: 2, id: "r1", nodes: [] }));
    await expect(loadRun(repo, "r1")).rejects.toThrow(/r1\.json.*version/);
  });

  it("rejects a run id that doesn't match the file", async () => {
    await saveRun(sampleRun());
    await writeFile(runFile(repo, "r1"), JSON.stringify({ ...sampleRun("r2") }));
    await expect(loadRun(repo, "r1")).rejects.toThrow(/r1\.json.*id/);
  });

  it("reports a missing run clearly", async () => {
    await expect(loadRun(repo, "nope")).rejects.toThrow(/no run nope/);
  });
});

describe("listRuns", () => {
  it("is empty when nothing was saved", async () => {
    expect(await listRuns(repo)).toEqual([]);
  });

  it("lists saved runs sorted", async () => {
    await saveRun(sampleRun("r2"));
    await saveRun(sampleRun("r1"));
    expect(await listRuns(repo)).toEqual(["r1", "r2"]);
  });
});

describe("overlapping saves", () => {
  it("never reject, and the last call wins even when an older save is bigger", async () => {
    const base = sampleRun();
    const saves = Array.from({ length: 40 }, (_, i) =>
      saveRun({ ...base, task: `v${i}${"x".repeat((40 - i) * 2000)}` }),
    );
    let reading = true;
    const reader = (async () => {
      while (reading) await loadRun(repo, "r1").catch(() => {});
    })();

    const results = await Promise.allSettled(saves);
    reading = false;
    await reader;

    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect((await loadRun(repo, "r1")).task.startsWith("v39")).toBe(true);
  });

  it("writes the state as it was when saveRun was called", async () => {
    const run = sampleRun();
    const pending = saveRun(run);
    run.task = "changed after the call";
    await pending;
    expect((await loadRun(repo, "r1")).task).toBe("add login");
  });
});

describe("loadRun shape checks", () => {
  type Mutate = (run: any) => void;
  const cases: [string, Mutate, RegExp][] = [
    ["a node that is not an object", (r) => { r.nodes[1] = 1; }, /node 1/],
    ["an unknown kind", (r) => { r.nodes[0].kind = "bogus"; }, /root.*kind/],
    ["an unknown status", (r) => { r.nodes[1].status = "zzz"; }, /root\.1.*status/],
    ["an unknown agent", (r) => { r.nodes[1].agent = "gpt"; }, /root\.1.*agent/],
    ["attempts that are not a count", (r) => { r.nodes[1].attempts = "a"; }, /root\.1.*attempts/],
    ["a bad node id", (r) => { r.nodes[1].id = "../x"; }, /node 1.*id/],
    ["a parent that does not exist", (r) => { r.nodes[1].parentId = "root.7"; }, /root\.1.*parent/],
    ["a branch that is not the node's own", (r) => { r.nodes[1].branch = "main"; }, /root\.1.*branch/],
    ["a worktree outside the run", (r) => { r.nodes[1].worktree = "C:\\Windows"; }, /root\.1.*worktree/],
    ["a run from another repo", (r) => { r.repo = "D:\\elsewhere"; }, /repo/],
    ["a missing task", (r) => { delete r.task; }, /task/],
  ];

  it.each(cases)("rejects %s", async (_name, mutate, message) => {
    await saveRun(sampleRun());
    const run = JSON.parse(JSON.stringify(sampleRun()));
    mutate(run);
    await writeFile(runFile(repo, "r1"), JSON.stringify(run));
    const err = await loadRun(repo, "r1").catch((e) => e);
    expect(err).toBeInstanceOf(RunStoreError);
    expect(err.message).toMatch(/r1\.json/);
    expect(err.message).toMatch(message);
  });
});

describe("run files and git", () => {
  it("keep .rivet/ out of git status from the first save", async () => {
    await saveRun(sampleRun());
    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("");
  });
});
