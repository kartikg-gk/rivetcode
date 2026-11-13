import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureCheckpoint, checkpointDiff, checkpointRef, dropCheckpoints, hasCheckpoint, restoreCheckpoint } from "../src/checkpoints.js";
import { git } from "../src/git.js";
import { makeRepo, removeRepo } from "./helpers.js";

let repo: string;
beforeEach(async () => { repo = await makeRepo(); });
afterEach(async () => { await removeRepo(repo); });

const status = async () => (await git(["status", "--porcelain"], repo)).trim();

describe("a turn's diff", () => {
  it("shows what changed between two prompts, and since the last one", async () => {
    const first = checkpointRef("run1-agent", "rivet-1-1"), second = checkpointRef("run1-agent", "rivet-1-2");
    await captureCheckpoint(repo, first);
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    await captureCheckpoint(repo, second);
    writeFileSync(join(repo, "b.txt"), "three\n");
    const turn1 = await checkpointDiff(repo, first, second);
    expect(turn1.files).toEqual([{ path: "a.txt", added: 2, removed: 0, binary: false }]);
    expect(turn1.diff).toContain("+two");
    const turn2 = await checkpointDiff(repo, second);
    expect(turn2.files.map((f) => f.path)).toEqual(["b.txt"]);
    expect(await status()).toContain("b.txt");
  });
});

describe("a file checkpoint", () => {
  it("saves the files without staging, committing or changing anything", async () => {
    writeFileSync(join(repo, "work.txt"), "draft");
    await git(["add", "work.txt"], repo);
    writeFileSync(join(repo, "loose.txt"), "untracked");
    const before = { status: await status(), head: (await git(["rev-parse", "HEAD"], repo)).trim(), branches: await git(["branch", "--list"], repo) };
    const ref = checkpointRef("run1-agent", "rivet-12-1");
    await captureCheckpoint(repo, ref);
    expect(await hasCheckpoint(repo, ref)).toBe(true);
    expect(await status()).toBe(before.status);
    expect((await git(["rev-parse", "HEAD"], repo)).trim()).toBe(before.head);
    expect(await git(["branch", "--list"], repo)).toBe(before.branches);
    expect((await git(["show", `${ref}:loose.txt`], repo))).toBe("untracked");
  });

  it("puts changed, deleted and new files back as they were", async () => {
    const tracked = (await git(["ls-files"], repo)).split(/\r?\n/).filter(Boolean)[0]!;
    const original = readFileSync(join(repo, tracked), "utf8");
    writeFileSync(join(repo, "kept.txt"), "before");
    const ref = checkpointRef("run1-agent", "rivet-12-2");
    await captureCheckpoint(repo, ref);
    writeFileSync(join(repo, tracked), "changed by the agent");
    writeFileSync(join(repo, "kept.txt"), "after");
    mkdirSync(join(repo, "made"), { recursive: true });
    writeFileSync(join(repo, "made", "new.txt"), "new");
    const result = await restoreCheckpoint(repo, ref);
    expect(readFileSync(join(repo, tracked), "utf8")).toBe(original);
    expect(readFileSync(join(repo, "kept.txt"), "utf8")).toBe("before");
    expect(existsSync(join(repo, "made", "new.txt"))).toBe(false);
    expect(result).toEqual({ restored: 2, removed: 1 });
  });

  it("leaves ignored files alone", async () => {
    writeFileSync(join(repo, ".gitignore"), "cache/\n");
    const ref = checkpointRef("run1-agent", "rivet-12-3");
    await captureCheckpoint(repo, ref);
    mkdirSync(join(repo, "cache"), { recursive: true });
    writeFileSync(join(repo, "cache", "big.bin"), "x");
    await restoreCheckpoint(repo, ref);
    expect(existsSync(join(repo, "cache", "big.bin"))).toBe(true);
  });

  it("is removed with its run", async () => {
    await captureCheckpoint(repo, checkpointRef("gone-agent", "a"));
    await captureCheckpoint(repo, checkpointRef("gone-agent", "b"));
    await captureCheckpoint(repo, checkpointRef("other-agent", "a"));
    expect(await dropCheckpoints(repo, "gone-agent")).toBe(2);
    expect(await hasCheckpoint(repo, checkpointRef("other-agent", "a"))).toBe(true);
  });
});
