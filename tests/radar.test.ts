import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import { radar, wouldConflict } from "../src/scheduler/radar.js";
import type { Run } from "../src/store.js";
import { buildTree } from "../src/tree.js";
import { makeRepo, removeRepo } from "./helpers.js";

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
  it("flags running siblings and leaves that clash with their parent", async () => {
    const nodes = buildTree({ runId: "r1", project: "p", dataDir: repo, defaultAgent: "claude", plan: {
      title: "root", prompt: "r", children: [{ title: "x", prompt: "x" }, { title: "y", prompt: "y" }, { title: "z", prompt: "z" }],
    } });
    await branch("rivet/r1/root", "main", { "README.txt": "parent version\n" });
    await branch("rivet/r1/root.1", "main", { "shared.txt": "x\n" });
    await branch("rivet/r1/root.2", "main", { "shared.txt": "y\n" });
    await branch("rivet/r1/root.3", "main", { "README.txt": "z version\n" });
    const run: Run = { id: "r1", project: "p", repo, base: "main", task: "t", createdAt: "", nodes: nodes.map((n) => (n.kind === "leaf" ? { ...n, status: "running" } : n)) };
    expect(await radar(run)).toEqual([
      { a: "root.1", b: "root.2", files: ["shared.txt"] },
      { a: "root.3", b: "root", files: ["README.txt"] },
    ]);
  });
});
