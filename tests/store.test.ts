import { readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
