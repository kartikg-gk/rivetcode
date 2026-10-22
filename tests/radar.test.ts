import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import { radar, wouldConflict } from "../src/scheduler/radar.js";
import type { Run } from "../src/store.js";
import { makeRepo, removeRepo, sessionRun } from "./helpers.js";

let repo: string;
beforeEach(async () => { repo = await makeRepo(); });
afterEach(async () => { await removeRepo(repo); });

async function branch(name: string, from: string, files: Record<string, string>): Promise<void> {
  await git(["checkout", "-q", "-b", name, from], repo);
  for (const [f, c] of Object.entries(files)) await writeFile(join(repo, f), c);
  await git(["add", "."], repo);
  await git(["commit", "-q", "-m", name], repo);
  await git(["checkout", "-q", "main"], repo);
}

describe("wouldConflict", () => {
  it("lists conflicting files without touching any worktree", async () => {
    await branch("a", "main", { "README.txt": "from a\n", "a.txt": "a" });
    await branch("b", "main", { "README.txt": "from b\n" });
    await branch("c", "main", { "c.txt": "c" });
    expect(await wouldConflict(repo, "a", "b")).toEqual(["README.txt"]);
    expect(await wouldConflict(repo, "a", "c")).toEqual([]);
    expect(await wouldConflict(repo, "a", "nope")).toBeNull();
    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("");
  });
});

describe("radar", () => {
  it("flags workers of a project whose unlanded branches would clash while one still works", async () => {
    const worker = (id: string, status: "running" | "done", role: "worker" | "orchestrator" = "worker", prStatus?: "merged"): Run => {
      const r = sessionRun(repo, { id, project: "p", role });
      return { ...r, repo, node: { ...r.node, status, ...(prStatus ? { prStatus } : {}) } };
    };
    await branch("rivet/r1/agent", "main", { "shared.txt": "x\n" });
    await branch("rivet/r2/agent", "main", { "shared.txt": "y\n" });
    await branch("rivet/r3/agent", "main", { "other.txt": "z\n" });
    await branch("rivet/r4/agent", "main", { "shared.txt": "done already\n" });
    await branch("rivet/r5/agent", "main", { "shared.txt": "orchestrator\n" });
    await branch("rivet/r6/agent", "main", { "shared.txt": "merged already\n" });
    await branch("rivet/r7/agent", "main", { "shared.txt": "done too\n" });
    const runs = [worker("r1", "running"), worker("r2", "running"), worker("r3", "running"), worker("r4", "done"),
      worker("r5", "running", "orchestrator"), worker("r6", "done", "worker", "merged"), worker("r7", "done")];
    // A done worker counts until its work merges; two done workers are no longer anyone's to change.
    expect(await radar(runs)).toEqual([
      { a: "r1", b: "r2", files: ["shared.txt"] }, { a: "r1", b: "r4", files: ["shared.txt"] }, { a: "r1", b: "r7", files: ["shared.txt"] },
      { a: "r2", b: "r4", files: ["shared.txt"] }, { a: "r2", b: "r7", files: ["shared.txt"] },
    ]);
  });
});
