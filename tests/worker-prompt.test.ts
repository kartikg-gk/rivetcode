import { describe, expect, it } from "vitest";
import { workerPrompt } from "../src/scheduler/prompts.js";
import { sessionRun } from "./helpers.js";

describe("worker prompt", () => {
  it("gives a Codex worker a scoped commit command", () => {
    const codex = workerPrompt(sessionRun("/data", { agent: "codex", task: "add mean" }));
    expect(codex).toContain('Use rivet commit --message "<summary>"');
    expect(workerPrompt(sessionRun("/data", { agent: "claude", task: "add mean" }))).not.toContain("rivet commit --message");
  });
});

describe("partner prompt", () => {
  it("gives only the task, shares the worktree, and never commits; a review changes nothing", async () => {
    const { partnerPrompt } = await import("../src/scheduler/prompts.js");
    const run = sessionRun("/data", { agent: "claude", task: "the big task" });
    const work = partnerPrompt(run, "write the parser", false, "codex");
    expect(work).toMatch(/^Your task: write the parser\n/);
    expect(work).not.toContain("the big task");
    expect(work).toContain("Do not commit, push or switch branches");
    const review = partnerPrompt(run, "", true, "codex");
    expect(review).toMatch(/^Review the changes made so far in this worktree\./);
    expect(review).toContain("Change nothing");
    expect(workerPromptHas("rivet delegate")).toBe(true);
  });
});

function workerPromptHas(text: string): boolean {
  return workerPrompt(sessionRun("/data", { agent: "claude", task: "t" })).includes(text);
}
