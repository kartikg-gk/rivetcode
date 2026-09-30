import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, GitError } from "../src/git.js";
import { makeRepo, removeRepo } from "./helpers.js";

let repo: string;
beforeEach(async () => { repo = await makeRepo(); });
afterEach(async () => { await removeRepo(repo); });

describe("git", () => {
  it("returns stdout", async () => {
    const out = await git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
    expect(out.trim()).toBe("main");
  });

  it("rejects with GitError carrying exit code and stderr", async () => {
    const err = await git(["rev-parse", "--verify", "no-such-ref"], repo).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err.code).toBe(128);
    expect(err.stderr).toMatch(/no-such-ref|Needed a single revision/);
    expect(err.args).toEqual(["rev-parse", "--verify", "no-such-ref"]);
  });
});
