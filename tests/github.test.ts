import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubClient, githubToken, prStatus, repoSlug, type PrFacts } from "../src/github/github.js";
import { mockGitHub, type MockGitHub } from "./github-mock.js";

describe("repoSlug", () => {
  it.each([
    ["https://kartikg-gk@github.com/kartikg-gk/rivet-code1.git", "kartikg-gk/rivet-code1"],
    ["https://github.com/o/r", "o/r"],
    ["git@github.com:o/r.git", "o/r"],
    ["/some/local/path", null],
  ])("%s -> %s", (url, slug) => { expect(repoSlug(url)).toBe(slug); });
});

describe("githubToken", () => {
  it("prefers GITHUB_TOKEN, then GH_TOKEN", async () => {
    expect(await githubToken({ GITHUB_TOKEN: " a " , GH_TOKEN: "b" }, "")).toBe("a");
    expect(await githubToken({ GH_TOKEN: "b" }, "")).toBe("b");
  });
});

const facts = (over: Partial<PrFacts>): PrFacts => ({
  open: true, merged: false, draft: false, ci: "passing", review: "none", mergeability: "unknown", reviewComments: false, headSha: "s", ...over,
});

describe("prStatus", () => {
  it("ranks what needs attention first", () => {
    expect(prStatus(facts({ merged: true, open: false }))).toBe("merged");
    expect(prStatus(facts({ open: false }))).toBe("terminated");
    expect(prStatus(facts({ ci: "failing", draft: true }))).toBe("ci_failed");
    expect(prStatus(facts({ draft: true, review: "changes_requested" }))).toBe("draft");
    expect(prStatus(facts({ reviewComments: true, mergeability: "mergeable" }))).toBe("changes_requested");
    expect(prStatus(facts({ mergeability: "mergeable", review: "review_required" }))).toBe("mergeable");
    expect(prStatus(facts({ review: "review_required" }))).toBe("review_pending");
    expect(prStatus(facts({ mergeability: "blocked", review: "approved" }))).toBe("pr_open");
    expect(prStatus(facts({ review: "approved" }))).toBe("approved");
    expect(prStatus(facts({}))).toBe("pr_open");
  });
});

describe("githubClient", () => {
  let gh: MockGitHub;
  beforeEach(async () => { gh = await mockGitHub(); });
  afterEach(async () => { await gh.close(); });
  const client = () => githubClient({ repo: "o/r", token: "t0ken", api: gh.api });

  it("creates a pull request", async () => {
    expect(await client().createPr({ title: "t", head: "rivet/r1/root", base: "main", body: "b" }))
      .toEqual({ number: 1, url: "https://github.com/o/r/pull/1" });
    expect(gh.prs[0]).toMatchObject({ title: "t", base: "main", body: "b", head: { ref: "rivet/r1/root" } });
  });

  it("gathers CI, reviews, mergeability and comments", async () => {
    await client().createPr({ title: "t", head: "h", base: "main", body: "" });
    gh.prs[0]!.mergeable_state = "clean";
    gh.checks.sha1 = [{ id: 5, status: "completed", conclusion: "failure" }, { id: 6, status: "completed", conclusion: "success" }];
    gh.annotations[5] = [{ path: "src/a.ts" }, { path: "src/a.ts" }];
    gh.reviews[1] = [{ user: { login: "x" }, state: "CHANGES_REQUESTED" }, { user: { login: "x" }, state: "APPROVED" }];
    gh.comments[1] = [{ commit_id: "sha1", path: "src/b.ts", line: 3, body: "rename this" }, { commit_id: "old", path: "c", line: 1, body: "stale" }];
    expect(await client().facts(1)).toEqual({
      open: true, merged: false, draft: false, ci: "failing", review: "approved", mergeability: "mergeable", reviewComments: true, headSha: "sha1",
    });
    expect(await client().failedPaths(1)).toEqual(["src/a.ts"]);
    expect(await client().reviewComments(1)).toEqual([{ path: "src/b.ts", line: 3, body: "rename this" }]);
  });

  it("reports pending and unknown CI", async () => {
    await client().createPr({ title: "t", head: "h", base: "main", body: "" });
    expect((await client().facts(1)).ci).toBe("unknown");
    gh.checks.sha1 = [{ id: 1, status: "in_progress", conclusion: null }];
    expect((await client().facts(1)).ci).toBe("pending");
  });

  it("explains API errors", async () => {
    await expect(githubClient({ repo: "o/r", token: "wrong", api: gh.api }).facts(1)).rejects.toThrow(/401/);
  });
});
