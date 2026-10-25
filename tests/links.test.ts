import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import { linkListed, recordedLinks } from "../src/links.js";
import { worktreePath } from "../src/paths.js";
import { createWorktree, isDirty, removeWorktree, waitForTrash } from "../src/worktree.js";
import { makeDataDir, makeRepo, removeRepo } from "./helpers.js";

let repo: string;
let data: string;
let wt: string;
beforeEach(async () => {
  repo = await makeRepo();
  data = await makeDataDir();
  // "node_modules/" matches folders only, as most projects write it.
  await writeFile(join(repo, ".gitignore"), "node_modules/\n.env\n");
  await git(["add", ".gitignore"], repo);
  await git(["commit", "-q", "-m", "ignore"], repo);
  await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
  await writeFile(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  wt = worktreePath(data, "proj", "r1", "agent");
  await createWorktree({ repo, path: wt, branch: "rivet/r1/agent", from: "main" });
});
afterEach(async () => {
  await removeWorktree(data, repo, wt).catch(() => {});
  await waitForTrash();
  await removeRepo(repo);
  await removeRepo(data);
});

describe("linked folders", () => {
  it("links an ignored folder into the worktree, which stays clean", async () => {
    expect(await linkListed(repo, wt, ["node_modules"])).toEqual(["node_modules"]);
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(await readFile(join(wt, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(await isDirty(wt)).toBe(false);
    expect(await recordedLinks(wt)).toEqual(["node_modules"]);
  });

  it("removing the worktree takes the link out and leaves the real folder alone", async () => {
    await linkListed(repo, wt, ["node_modules"]);
    await removeWorktree(data, repo, wt);
    await waitForTrash();
    expect(existsSync(wt)).toBe(false);
    expect(await readFile(join(repo, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("refuses a path git tracks, and skips one that does not exist", async () => {
    await expect(linkListed(repo, wt, ["README.txt"])).rejects.toThrow(/only takes paths git ignores/);
    await expect(linkListed(repo, wt, ["../x"])).rejects.toThrow(/inside the repo/);
    expect(await linkListed(repo, wt, [".env"])).toEqual([]);
  });
});
