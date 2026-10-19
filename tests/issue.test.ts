import { describe, expect, it } from "vitest";
import { ISSUE_BODY_LIMIT, issueNumber, issueTask, type Issue } from "../src/scheduler/issue.js";

const issue: Issue = { number: 7, title: "Crash on empty input", state: "open", url: "https://github.com/o/r/issues/7", labels: ["bug"], assignees: [], body: "Steps: run with no args." };

describe("issue references", () => {
  it("accepts a number, owner/repo#n and the issue's address in this repository", () => {
    expect(issueNumber("7", "o/r")).toBe(7);
    expect(issueNumber("#7", "o/r")).toBe(7);
    expect(issueNumber("O/R#7", "o/r")).toBe(7);
    expect(issueNumber("https://github.com/o/r/issues/7", "o/r")).toBe(7);
  });

  it("refuses another repository's issue and anything else", () => {
    expect(() => issueNumber("x/y#7", "o/r")).toThrow(/not in this repository/);
    expect(() => issueNumber("seven", "o/r")).toThrow(/is not an issue/);
    expect(() => issueNumber("0", "o/r")).toThrow(/is not an issue/);
  });
});

describe("a task from an issue", () => {
  it("is the issue itself without words, and the words with the issue below them otherwise", () => {
    const alone = issueTask(issue);
    expect(alone).toMatch(/^Resolve issue #7\./);
    expect(alone).toContain("Title: Crash on empty input\nState: open\nURL: https://github.com/o/r/issues/7\nLabels: bug\n\nBody:\nSteps: run with no args.");
    expect(issueTask(issue, "fix it in cli.ts")).toMatch(/^fix it in cli\.ts\n\nThe issue this is about:\nIssue: #7/);
  });

  it("cuts a long issue text and says so", () => {
    const long = issueTask({ ...issue, body: "x".repeat(ISSUE_BODY_LIMIT + 5) });
    expect(long).toContain(`[The issue text is cut at ${ISSUE_BODY_LIMIT} characters.]`);
    expect(long).not.toContain("x".repeat(ISSUE_BODY_LIMIT + 1));
  });
});
