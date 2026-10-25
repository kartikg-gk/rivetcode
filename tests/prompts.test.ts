import { describe, expect, it } from "vitest";
import { ciFeedback, feedbackRules, reviewFeedback } from "../src/scheduler/prompts.js";

const pr = { number: 12, url: "https://github.com/o/r/pull/12" };

describe("pull request feedback for a worker", () => {
  it("points the worker at the failure, or hands over what Rivet fetched", () => {
    expect(ciFeedback(pr)).toBe([
      "CI failed on pull request #12 (https://github.com/o/r/pull/12).",
      'See what failed with "gh pr checks 12" and read the failing run\'s log with "gh run view <run id> --log-failed", then fix it.',
    ].join("\n"));
    expect(ciFeedback(pr, ["a.ts"])).toBe("CI failed on the pull request in: a.ts. Fix it.");
    expect(reviewFeedback(pr)).toMatch(/gh pr view 12 --comments" and the comments on code lines with "gh api repos\/o\/r\/pulls\/12\/comments"/);
    expect(reviewFeedback(pr, [{ path: "a.ts", line: 3, body: "null" }])).toBe("Review comments on the pull request:\na.ts:3: null\nAddress them.");
  });

  it("lets the worker run only the read commands for its own pull request", () => {
    expect(feedbackRules(pr)).toEqual([
      "Bash(gh pr checks 12:*)", "Bash(gh pr view 12:*)", "Bash(gh run view:*)", "Bash(gh api repos/o/r/pulls/12/comments)",
    ]);
  });
});
