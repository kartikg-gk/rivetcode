import { existsSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import { branchName, worktreePath } from "../src/paths.js";
import {
  clearStaleLocks,
  createWorktree,
  DirtyWorktreeError,
  isDirty,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  WorktreeError,
} from "../src/worktree.js";
import { makeRepo, removeRepo } from "./helpers.js";

let repo: string;
beforeEach(async () => { repo = await makeRepo(); });
afterEach(async () => { await removeRepo(repo); });

async function branchExists(branch: string): Promise<boolean> {
  const out = await git(["branch", "--list", branch], repo);
  return out.trim() !== "";
}

describe("createWorktree", () => {
  it("creates a worktree on a new branch from a start point", async () => {
    const path = worktreePath(repo, "r1", "root");
    const wt = await createWorktree({ repo, path, branch: branchName("r1", "root"), from: "main" });

    expect(wt.path).toBe(resolve(path));
    expect(wt.branch).toBe("rivet/r1/root");
    expect(existsSync(join(path, "README.txt"))).toBe(true);
    const mainHead = (await git(["rev-parse", "main"], repo)).trim();
    expect(wt.head).toBe(mainHead);
  });

  it("branches a child from its parent's branch", async () => {
    const parentPath = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path: parentPath, branch: "rivet/r1/root", from: "main" });
    await writeFile(join(parentPath, "parent.txt"), "p\n");
    await git(["add", "."], parentPath);
    await git(["commit", "-m", "parent work"], parentPath);

    const childPath = worktreePath(repo, "r1", "root.1");
    await createWorktree({ repo, path: childPath, branch: "rivet/r1/root.1", from: "rivet/r1/root" });

    expect(existsSync(join(childPath, "parent.txt"))).toBe(true);
  });

  it("keeps the main checkout clean (.rivet/ is excluded)", async () => {
    await createWorktree({ repo, path: worktreePath(repo, "r1", "root"), branch: "rivet/r1/root", from: "main" });
    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("");
  });

  it("refuses an existing branch and leaves no directory", async () => {
    await git(["branch", "rivet/r1/root"], repo);
    const path = worktreePath(repo, "r1", "root");
    await expect(
      createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" }),
    ).rejects.toThrow(WorktreeError);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses an existing path and creates no branch", async () => {
    const path = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await expect(
      createWorktree({ repo, path, branch: "rivet/r1/other", from: "main" }),
    ).rejects.toThrow(WorktreeError);
    expect(await branchExists("rivet/r1/other")).toBe(false);
  });

  it("fails on a missing start point and leaves nothing behind", async () => {
    const path = worktreePath(repo, "r1", "root");
    await expect(
      createWorktree({ repo, path, branch: "rivet/r1/root", from: "no-such-branch" }),
    ).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
    expect(await branchExists("rivet/r1/root")).toBe(false);
  });
});

describe("listWorktrees", () => {
  it("lists the main checkout and created worktrees", async () => {
    const path = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });

    const list = await listWorktrees(repo);
    expect(list.map((w) => w.path)).toEqual([resolve(repo), resolve(path)]);
    expect(list[0]!.branch).toBe("main");
    expect(list[1]!.branch).toBe("rivet/r1/root");
    expect(list.every((w) => w.prunable === false)).toBe(true);
  });
});

describe("isDirty", () => {
  it("is false for a fresh worktree", async () => {
    const path = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    expect(await isDirty(path)).toBe(false);
  });

  it("is true for a modified tracked file", async () => {
    const path = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await writeFile(join(path, "README.txt"), "changed\n");
    expect(await isDirty(path)).toBe(true);
  });

  it("is true for an untracked file nobody added", async () => {
    const path = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await writeFile(join(path, "new.ts"), "export {}\n");
    expect(await isDirty(path)).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree and keeps its branch", async () => {
    const path = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await removeWorktree(repo, path);
    expect(existsSync(path)).toBe(false);
    expect(await branchExists("rivet/r1/root")).toBe(true);
    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([resolve(repo)]);
  });

  it("refuses a worktree with only an untracked file, and leaves it intact", async () => {
    const path = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await writeFile(join(path, "new.ts"), "export {}\n");
    await expect(removeWorktree(repo, path)).rejects.toThrow(DirtyWorktreeError);
    expect(existsSync(join(path, "new.ts"))).toBe(true);
  });

  it("handles a worktree directory deleted by hand", async () => {
    const path = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await rm(path, { recursive: true, force: true });
    await removeWorktree(repo, path);
    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([resolve(repo)]);
  });
});

describe("pruneWorktrees", () => {
  it("drops records of missing worktree directories", async () => {
    const path = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await rm(path, { recursive: true, force: true });
    expect((await listWorktrees(repo))[1]!.prunable).toBe(true);
    await pruneWorktrees(repo);
    expect(await listWorktrees(repo)).toHaveLength(1);
  });
});

describe("clearStaleLocks", () => {
  const HOUR = 60 * 60 * 1000;

  async function age(file: string, msAgo: number) {
    const t = new Date(Date.now() - msAgo);
    await utimes(file, t, t);
  }

  it("removes an old index.lock so git works again", async () => {
    const lock = join(repo, ".git", "index.lock");
    await writeFile(lock, "");
    await age(lock, HOUR);
    await writeFile(join(repo, "a.txt"), "a\n");
    await expect(git(["add", "a.txt"], repo)).rejects.toThrow(/index\.lock/);

    const removed = await clearStaleLocks(repo);

    expect(removed).toEqual([resolve(lock)]);
    await git(["add", "a.txt"], repo);
  });

  it("keeps a fresh lock (a live git operation may own it)", async () => {
    const lock = join(repo, ".git", "index.lock");
    await writeFile(lock, "");
    expect(await clearStaleLocks(repo)).toEqual([]);
    expect(existsSync(lock)).toBe(true);
  });

  it("finds stale locks inside a worktree's git dir and under refs/", async () => {
    const path = worktreePath(repo, "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    const wtGitDir = resolve(path, (await git(["rev-parse", "--git-dir"], path)).trim());
    const wtLock = join(wtGitDir, "index.lock");
    const refLock = join(repo, ".git", "refs", "heads", "rivet", "r1", "root.lock");
    await writeFile(wtLock, "");
    await mkdir(join(repo, ".git", "refs", "heads", "rivet", "r1"), { recursive: true });
    await writeFile(refLock, "");
    await age(wtLock, HOUR);
    await age(refLock, HOUR);

    const removed = await clearStaleLocks(repo);

    expect(removed.sort()).toEqual([resolve(wtLock), resolve(refLock)].sort());
  });
});
