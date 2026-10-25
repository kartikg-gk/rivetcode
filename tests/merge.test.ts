import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import {
  abortMerge, commitLeftovers, finishResolution, headOf, mergeBranch, resetTo, runCommand, workingTree,
} from "../src/merge.js";
import { isDirty } from "../src/worktree.js";
import { makeRepo, removeRepo } from "./helpers.js";

let repo: string;
beforeEach(async () => { repo = await makeRepo(); });
afterEach(async () => { await removeRepo(repo); });

async function branchWith(name: string, file: string, content: string): Promise<void> {
  await git(["checkout", "-q", "-b", name, "main"], repo);
  await writeFile(join(repo, file), content);
  await git(["add", "."], repo);
  await git(["commit", "-q", "-m", `${name} edits ${file}`], repo);
  await git(["checkout", "-q", "main"], repo);
}

describe("commitLeftovers", () => {
  it("commits anything uncommitted, including new files", async () => {
    await writeFile(join(repo, "new.txt"), "n");
    await writeFile(join(repo, "README.txt"), "changed");
    expect(await commitLeftovers(repo, "save work")).toBe(true);
    expect(await isDirty(repo)).toBe(false);
    expect((await git(["log", "-1", "--format=%s"], repo)).trim()).toBe("save work");
  });

  it("does nothing on a clean tree", async () => {
    const before = await headOf(repo);
    expect(await commitLeftovers(repo, "x")).toBe(false);
    expect(await headOf(repo)).toBe(before);
  });
});

describe("mergeBranch", () => {
  it("merges with a merge commit", async () => {
    await branchWith("a", "a.txt", "a");
    const result = await mergeBranch(repo, "a", "merge a");
    expect(result).toEqual({ ok: true });
    expect((await git(["log", "-1", "--format=%P"], repo)).trim().split(" ")).toHaveLength(2);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("a");
  });

  it("reports conflicted files and can abort cleanly", async () => {
    await branchWith("a", "README.txt", "from a\n");
    await branchWith("b", "README.txt", "from b\n");
    expect(await mergeBranch(repo, "a", "merge a")).toEqual({ ok: true });
    const before = await headOf(repo);
    expect(await mergeBranch(repo, "b", "merge b")).toEqual({ ok: false, conflicts: ["README.txt"] });
    await abortMerge(repo);
    expect(await headOf(repo)).toBe(before);
    expect(await isDirty(repo)).toBe(false);
  });

  it("throws for a branch that does not exist", async () => {
    await expect(mergeBranch(repo, "nope", "m")).rejects.toThrow();
  });
});

describe("finishResolution", () => {
  async function conflicted(): Promise<void> {
    await branchWith("a", "README.txt", "from a\n");
    await branchWith("b", "README.txt", "from b\n");
    await mergeBranch(repo, "a", "merge a");
    await mergeBranch(repo, "b", "merge b");
  }

  it("commits the merge once every conflict is resolved", async () => {
    await conflicted();
    await writeFile(join(repo, "README.txt"), "from a and b\n");
    expect(await finishResolution(repo, ["README.txt"])).toEqual({ ok: true });
    expect(await isDirty(repo)).toBe(false);
    expect((await git(["log", "-1", "--format=%P"], repo)).trim().split(" ")).toHaveLength(2);
  });

  it("accepts a merge the resolver already committed", async () => {
    await conflicted();
    await writeFile(join(repo, "README.txt"), "resolved\n");
    await git(["commit", "-q", "-am", "resolved"], repo);
    expect(await finishResolution(repo, ["README.txt"])).toEqual({ ok: true });
  });

  it("refuses leftover conflict markers", async () => {
    await conflicted();
    expect(await finishResolution(repo, ["README.txt"])).toMatchObject({ ok: false, reason: expect.stringMatching(/conflict markers|unresolved/) });
  });

  it("refuses edits outside the conflicted files", async () => {
    await conflicted();
    await writeFile(join(repo, "README.txt"), "resolved\n");
    await writeFile(join(repo, "sneaky.txt"), "feature code");
    expect(await finishResolution(repo, ["README.txt"])).toMatchObject({ ok: false, reason: expect.stringMatching(/sneaky\.txt/) });
  });
});

describe("resetTo", () => {
  it("returns a clean worktree to an earlier commit", async () => {
    const before = await headOf(repo);
    await branchWith("a", "a.txt", "a");
    await mergeBranch(repo, "a", "merge a");
    await resetTo(repo, before);
    expect(await headOf(repo)).toBe(before);
  });

  it("refuses to throw away uncommitted work", async () => {
    const before = await headOf(repo);
    await writeFile(join(repo, "README.txt"), "unsaved");
    await expect(resetTo(repo, before)).rejects.toThrow(/uncommitted/);
  });
});

describe("runCommand", () => {
  it("passes on exit 0 and keeps the output", async () => {
    const r = await runCommand(`node -e "console.log('fine')"`, repo, 10_000);
    expect(r).toMatchObject({ ok: true });
    expect(r.output).toContain("fine");
  });

  it("fails on a non-zero exit or a timeout", async () => {
    expect(await runCommand(`node -e "console.error('broken'); process.exit(3)"`, repo, 10_000))
      .toMatchObject({ ok: false, output: expect.stringContaining("broken") });
    expect(await runCommand(`node -e "setTimeout(() => {}, 10000)"`, repo, 300))
      .toMatchObject({ ok: false, output: expect.stringContaining("timed out") });
  });
});

describe("workingTree", () => {
  it("names the files as they are: the same before and after a commit, new after a change", async () => {
    const clean = await workingTree(repo);
    expect(clean).toBe((await git(["rev-parse", "HEAD^{tree}"], repo)).trim());
    await writeFile(join(repo, "new.txt"), "n");
    const edited = await workingTree(repo);
    expect(edited).not.toBe(clean);
    // It leaves the real index alone.
    expect((await git(["status", "--porcelain"], repo)).trim()).toBe("?? new.txt");
    await commitLeftovers(repo, "save");
    expect(await workingTree(repo)).toBe(edited);
    await writeFile(join(repo, "new.txt"), "changed");
    expect(await workingTree(repo)).not.toBe(edited);
  });
});
