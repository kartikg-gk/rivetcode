import { describe, expect, it } from "vitest";
import { fromCodexJson, fromHook, readableOutput } from "../src/timeline.js";

describe("timeline from hooks", () => {
  it("reads Claude's prompt, tool calls, results and last reply, with the fields seen live", () => {
    expect(fromHook("claude-code", "user-prompt-submit", { prompt: "fix the bug" })).toEqual([{ kind: "prompt", text: "fix the bug" }]);
    expect(fromHook("claude-code", "pre-tool-use", { tool_name: "Bash", tool_input: { command: "npm test", description: "run" } }))
      .toEqual([{ kind: "tool", tool: "Bash", text: "npm test" }]);
    expect(fromHook("claude-code", "pre-tool-use", { tool_name: "Edit", tool_input: { file_path: "src/a.ts", old_string: "x" } }))
      .toEqual([{ kind: "tool", tool: "Edit", text: "src/a.ts" }]);
    const result = fromHook("claude-code", "post-tool-use", { tool_name: "Bash", tool_input: {}, tool_response: { stdout: "x".repeat(5000) } });
    expect(result[0]).toMatchObject({ kind: "result", tool: "Bash" });
    expect(result[0]!.text).toMatch(/\[cut at 4000 characters\]$/);
    expect(fromHook("claude-code", "stop", { last_assistant_message: "Done: tests pass." })).toEqual([{ kind: "assistant", text: "Done: tests pass." }]);
    expect(fromHook("claude-code", "stop", {})).toEqual([]);
    expect(fromHook("claude-code", "session-start", { prompt: "x" })).toEqual([]);
  });
});

describe("timeline from Codex --json", () => {
  it("reads replies, commands and their output, and file changes; other lines are not events", () => {
    expect(fromCodexJson('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will run git status."}}'))
      .toEqual([{ kind: "assistant", text: "I will run git status." }]);
    expect(fromCodexJson('{"type":"item.started","item":{"type":"command_execution","command":"git status"}}'))
      .toEqual([{ kind: "tool", tool: "shell", text: "git status" }]);
    expect(fromCodexJson('{"type":"item.completed","item":{"type":"command_execution","command":"git status","aggregated_output":"On branch main"}}'))
      .toEqual([{ kind: "result", tool: "shell", text: "On branch main" }]);
    expect(fromCodexJson('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.ts","kind":"update"}]}}'))
      .toEqual([{ kind: "tool", tool: "edit", text: "update a.ts" }]);
    expect(fromCodexJson('{"type":"turn.completed"}')).toEqual([]);
    expect(fromCodexJson("plain text")).toBeNull();
    expect(readableOutput(['{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}', "error: boom"])).toEqual(["hi", "error: boom"]);
  });
});
