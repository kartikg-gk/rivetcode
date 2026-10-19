import { describe, expect, it } from "vitest";
import { workerPrompt } from "../src/scheduler/prompts.js";
import { sessionRun } from "./helpers.js";

describe("worker prompt", () => {
  it("tells a codex worker that Rivet commits when its sandbox cannot", () => {
    const codex = workerPrompt(sessionRun("/data", { agent: "codex", task: "add mean" }));
    expect(codex).toContain('If git commit fails with "Permission denied" (your sandbox), leave the changes uncommitted:');
    expect(workerPrompt(sessionRun("/data", { agent: "claude", task: "add mean" }))).not.toContain("Permission denied");
  });
});
