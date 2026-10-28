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

describe("taking over a worker from another agent", () => {
  it("hands over each finished exchange, credited to the agent that answered", async () => {
    const { handoffTurns } = await import("../src/scheduler/prompts.js");
    const turns = handoffTurns([
      { kind: "prompt", text: "do the task" }, { kind: "assistant", text: "thinking" }, { kind: "assistant", text: "done part 1", agent: "claude" },
      { kind: "message", text: "also b" }, { kind: "assistant", text: "b done", agent: "codex" },
      { kind: "message", text: "unanswered" }, { kind: "assistant", text: "half", streaming: true },
    ], "codex");
    expect(turns).toEqual([
      { agent: "claude", request: "do the task", reply: "done part 1" },
      { agent: "codex", request: "also b", reply: "b done" },
    ]);
    expect(handoffTurns(Array.from({ length: 30 }, (_, i) => [{ kind: "message", text: `q${i}` }, { kind: "assistant", text: "a" }]).flat(), "x")).toHaveLength(10);
  });

  it("points a chat's new agent at the run's own record, a terminal's at the old agent's file", async () => {
    const { switchPrompt } = await import("../src/scheduler/prompts.js");
    const { sessionRun } = await import("./helpers.js");
    const run = sessionRun("/data", { id: "r1", project: "p" });
    run.node = { ...run.node, agent: "codex" };
    const chat = switchPrompt(run, { agent: "claude", conversation: null, history: "rivet read r1 --activity", log: "", status: " M a.ts" });
    expect(chat).toContain("You take over this task from another agent (claude)");
    expect(chat).toContain("M a.ts");
    expect(chat).toContain("Its conversation so far, page by page: rivet read r1 --activity");
    const terminal = switchPrompt(run, { agent: "claude", conversation: "/c/x.jsonl", log: "abc1 first", status: "" });
    expect(terminal).toContain("Its conversation is saved at /c/x.jsonl.");
    expect(terminal).not.toContain("rivet read");
  });
});
