import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import { assertId, branchName, ensureExcluded, worktreePath } from "../src/paths.js";
import { makeRepo, removeRepo } from "./helpers.js";

describe("ids and names", () => {
  it("accepts tree-style ids", () => {
    expect(() => assertId("node", "root.1.2")).not.toThrow();
    expect(() => assertId("run", "r7")).not.toThrow();
  });

  it.each(["", "Root", "a/b", "a..b", "-x", "x.lock", "a b", "a\\b"])(
    "rejects %j",
    (id) => {
      expect(() => assertId("node", id)).toThrow(`invalid node id: "${id}"`);
    },
  );

  it("builds branch names and worktree paths", () => {
    expect(branchName("r7", "root.1")).toBe("rivet/r7/root.1");
    expect(worktreePath(join("C:", "repo x"), "r7", "root.1")).toBe(
      join("C:", "repo x", ".rivet", "wt", "r7", "root.1"),
    );
  });

  it("validates ids when building names", () => {
    expect(() => branchName("r7", "../x")).toThrow(/invalid node id/);
    expect(() => worktreePath("C:/r", "R7", "root")).toThrow(/invalid run id/);
  });
});

describe("ensureExcluded", () => {
  let repo: string;
  beforeEach(async () => { repo = await makeRepo(); });
  afterEach(async () => { await removeRepo(repo); });

  it("hides .rivet/ from git status, once", async () => {
    await mkdir(join(repo, ".rivet"), { recursive: true });
    await writeFile(join(repo, ".rivet", "x.txt"), "x");
    expect((await git(["status", "--porcelain"], repo)).trim()).not.toBe("");

    await ensureExcluded(repo);
    await ensureExcluded(repo);

    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("");
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split(/\r?\n/).filter((l) => l === ".rivet/")).toHaveLength(1);
  });
});
