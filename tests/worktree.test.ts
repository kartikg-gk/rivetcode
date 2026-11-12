import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import { branchName, worktreePath } from "../src/paths.js";
import { createWorktree, DirtyWorktreeError, isDirty, listWorktrees, pruneWorktrees, removeWorktree, emptyTrash, WorktreeError } from "../src/worktree.js";
import { makeDataDir, makeRepo, removeRepo } from "./helpers.js";

let repo: string;
let data: string;
beforeEach(async () => {
  repo = await makeRepo();
  data = await makeDataDir();
});
afterEach(async () => {
  await removeRepo(repo);
  await removeRepo(data);
});

const wtPath = (run: string, node: string) => worktreePath(data, "proj", run, node);

async function branchExists(branch: string): Promise<boolean> {
  const out = await git(["branch", "--list", branch], repo);
  return out.trim() !== "";
}

describe("createWorktree", () => {
  it("creates a worktree on a new branch from a start point", async () => {
    const path = wtPath("r1", "root");
    const wt = await createWorktree({ repo, path, branch: branchName("r1", "root"), from: "main" });

    expect(wt.path).toBe(resolve(path));
    expect(wt.branch).toBe("rivet/r1/root");
    expect(existsSync(join(path, "README.txt"))).toBe(true);
    const mainHead = (await git(["rev-parse", "main"], repo)).trim();
    expect(wt.head).toBe(mainHead);
  });

  it("branches a child from its parent's branch", async () => {
    const parentPath = wtPath("r1", "root");
    await createWorktree({ repo, path: parentPath, branch: "rivet/r1/root", from: "main" });
    await writeFile(join(parentPath, "parent.txt"), "p\n");
    await git(["add", "."], parentPath);
    await git(["commit", "-m", "parent work"], parentPath);

    const childPath = wtPath("r1", "root.1");
    await createWorktree({ repo, path: childPath, branch: "rivet/r1/root.1", from: "rivet/r1/root" });

    expect(existsSync(join(childPath, "parent.txt"))).toBe(true);
  });

  it("keeps the main checkout clean", async () => {
    await createWorktree({ repo, path: wtPath("r1", "root"), branch: "rivet/r1/root", from: "main" });
    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("");
  });

  it("refuses an existing branch and leaves no directory", async () => {
    await git(["branch", "rivet/r1/root"], repo);
    const path = wtPath("r1", "root");
    await expect(
      createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" }),
    ).rejects.toThrow(WorktreeError);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses an existing path and creates no branch", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await expect(
      createWorktree({ repo, path, branch: "rivet/r1/other", from: "main" }),
    ).rejects.toThrow(WorktreeError);
    expect(await branchExists("rivet/r1/other")).toBe(false);
  });

  it("fails on a missing start point and leaves nothing behind", async () => {
    const path = wtPath("r1", "root");
    await expect(
      createWorktree({ repo, path, branch: "rivet/r1/root", from: "no-such-branch" }),
    ).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
    expect(await branchExists("rivet/r1/root")).toBe(false);
  });
});

describe("createWorktree rollback", () => {
  // A start commit git accepts as a ref but refuses to check out: its tree has a ".git" entry.
  async function uncheckoutableCommit(): Promise<string> {
    const blob = (await git(["rev-parse", "HEAD:README.txt"], repo)).trim();
    const tree = execFileSync("git", ["mktree"], {
      cwd: repo,
      input: `100644 blob ${blob}\tREADME.txt\n100644 blob ${blob}\t.git\n`,
    }).toString().trim();
    return (await git(["commit-tree", tree, "-p", "HEAD", "-m", "bad"], repo)).trim();
  }

  it("deletes the branch it created when checkout fails, so a retry works", async () => {
    const bad = await uncheckoutableCommit();
    const path = wtPath("r1", "root");

    await expect(
      createWorktree({ repo, path, branch: "rivet/r1/root", from: bad }),
    ).rejects.toThrow();

    expect(await branchExists("rivet/r1/root")).toBe(false);
    expect(existsSync(path)).toBe(false);
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
  });

  it("re-creates at a path whose worktree was deleted by hand", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await rm(path, { recursive: true, force: true });

    const wt = await createWorktree({ repo, path, branch: "rivet/r1/again", from: "main" });

    expect(wt.branch).toBe("rivet/r1/again");
    expect(existsSync(join(path, "README.txt"))).toBe(true);
  });
});

describe("path canonicalization", () => {
  it.runIf(process.platform === "win32")(
    "returns the same path createWorktree and listWorktrees agree on, whatever case the caller used",
    async () => {
      const lower = repo.toLowerCase();
      const wt = await createWorktree({
        repo: lower,
        path: worktreePath(data.toLowerCase(), "proj", "r1", "root"),
        branch: "rivet/r1/root",
        from: "main",
      });
      const listed = (await listWorktrees(repo))[1]!;
      expect(wt.path).toBe(listed.path);
    },
  );
});

describe("listWorktrees", () => {
  it("lists the main checkout and created worktrees", async () => {
    const path = wtPath("r1", "root");
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
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    expect(await isDirty(path)).toBe(false);
  });

  it("is true for a modified tracked file", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await writeFile(join(path, "README.txt"), "changed\n");
    expect(await isDirty(path)).toBe(true);
  });

  it("is true for an untracked file nobody added", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await writeFile(join(path, "new.ts"), "export {}\n");
    expect(await isDirty(path)).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("removes a clean worktree and keeps its branch", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await removeWorktree(data, repo, path);
    expect(existsSync(path)).toBe(false);
    expect(await branchExists("rivet/r1/root")).toBe(true);
    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([resolve(repo)]);
  });

  it("refuses a worktree with only an untracked file, and leaves it intact", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await writeFile(join(path, "new.ts"), "export {}\n");
    await expect(removeWorktree(data, repo, path)).rejects.toThrow(DirtyWorktreeError);
    expect(existsSync(join(path, "new.ts"))).toBe(true);
  });

  it("handles a worktree directory deleted by hand", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await rm(path, { recursive: true, force: true });
    await removeWorktree(data, repo, path);
    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([resolve(repo)]);
  });
});

describe("removeWorktree after a partial removal", () => {
  it("waits for an interrupted removal to settle and prunes its registration", async () => {
    const path = wtPath("settling", "root");
    await createWorktree({ repo, path, branch: "rivet/settling/root", from: "main" });
    await rm(join(path, ".git"));
    const finish = new Promise<void>((resolve, reject) => {
      // Windows refuses to delete a folder another process is looking into (EBUSY); the
      // finishing process retries, as real removal tools do.
      setTimeout(() => { void rm(path, { recursive: true, maxRetries: 20, retryDelay: 50 }).then(resolve, reject); }, 250);
    });
    await removeWorktree(data, repo, path);
    await finish;
    expect(existsSync(path)).toBe(false);
    expect((await listWorktrees(repo)).map(w => w.path)).toEqual([resolve(repo)]);
  });

  it("preserves a broken checkout that never settles with an actionable error", async () => {
    const path = wtPath("broken", "root");
    await createWorktree({ repo, path, branch: "rivet/broken/root", from: "main" });
    await rm(join(path, ".git"));
    await writeFile(join(path, "keep.txt"), "preserve me");
    await expect(removeWorktree(data, repo, path)).rejects.toThrow(/inspect and preserve remaining files/);
    expect(existsSync(join(path, "keep.txt"))).toBe(true);
    expect(existsSync(join(repo, "README.txt"))).toBe(true);
  });
  it("cleans up an empty leftover directory git no longer tracks", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await git(["worktree", "remove", path], repo);
    await mkdir(path, { recursive: true });

    await removeWorktree(data, repo, path);

    expect(existsSync(path)).toBe(false);
  });

  it("refuses a non-empty directory that is not a worktree, and leaves it intact", async () => {
    const path = wtPath("r1", "root");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "keep.txt"), "k\n");

    await expect(removeWorktree(data, repo, path)).rejects.toThrow(WorktreeError);
    expect(existsSync(join(path, "keep.txt"))).toBe(true);
  });

  it("isDirty refuses a directory that is not a worktree root", async () => {
    const dir = join(repo, ".rivet", "wt", "r1", "root");
    await mkdir(dir, { recursive: true });
    await writeFile(join(repo, "README.txt"), "main repo is dirty\n");

    await expect(isDirty(dir)).rejects.toThrow(WorktreeError);
  });
});

describe("pruneWorktrees", () => {
  it("drops records of missing worktree directories", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await rm(path, { recursive: true, force: true });
    expect((await listWorktrees(repo))[1]!.prunable).toBe(true);
    await pruneWorktrees(repo);
    expect(await listWorktrees(repo)).toHaveLength(1);
  });
});

describe("concurrency", () => {
  it("a burst of parallel creates and removes never fails", async () => {
    for (let round = 0; round < 3; round++) {
      const old = Array.from({ length: 12 }, (_, i) => wtPath(`r${round}`, `a${i}`));
      await Promise.all(
        old.map((path, i) => createWorktree({ repo, path, branch: `rivet/r${round}/a${i}`, from: "main" })),
      );
      await Promise.all([
        ...old.map((path) => removeWorktree(data, repo, path)),
        ...Array.from({ length: 12 }, (_, i) =>
          createWorktree({
            repo,
            path: wtPath(`r${round}`, `b${i}`),
            branch: `rivet/r${round}/b${i}`,
            from: "main",
          }),
        ),
        pruneWorktrees(repo),
      ]);
    }
    expect(await listWorktrees(repo)).toHaveLength(1 + 3 * 12);
  }, 180_000);
});

describe("removal", () => {
  it("removes a clean worktree and git forgets it", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });

    await removeWorktree(data, repo, path);

    expect(existsSync(path)).toBe(false);
    expect((await listWorktrees(repo)).map((w) => w.path)).toEqual([resolve(repo)]);
  });

  it("leaves a dirty worktree as it was", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await writeFile(join(path, "new.ts"), "export {}\n");

    await expect(removeWorktree(data, repo, path)).rejects.toThrow(DirtyWorktreeError);

    expect(existsSync(join(path, "new.ts"))).toBe(true);
    expect((await listWorktrees(repo)).map((w) => w.path)).toContain(resolve(path));
  });

  it("leaves a locked worktree; git refuses it", async () => {
    const path = wtPath("r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
    await git(["worktree", "lock", path], repo);

    await expect(removeWorktree(data, repo, path)).rejects.toThrow(/locked/);

    expect(existsSync(join(path, "README.txt"))).toBe(true);
  });

  it("refuses a path outside the data dir's worktrees folder", async () => {
    await expect(removeWorktree(data, repo, join(repo, "..", "elsewhere"))).rejects.toThrow(/outside/);
  });

  it("deletes the trash folder earlier versions left", async () => {
    await mkdir(join(data, "worktrees", ".trash", "root-abc123", "deep"), { recursive: true });
    await writeFile(join(data, "worktrees", ".trash", "root-abc123", "deep", "f.txt"), "x");

    await emptyTrash(data);

    expect(existsSync(join(data, "worktrees", ".trash"))).toBe(false);
  });
});
