import { describe, expect, it } from "vitest";
import { fromClaudeStream, fromCodexJson, fromHook, fromStream, readableOutput, redact } from "../src/timeline.js";

describe("secrets on the timeline", () => {
  it("removes keys, tokens and named secrets, and leaves ordinary text alone", () => {
    const gh = "ghp_" + "a1".repeat(18);
    const sk = "sk-ant-" + "x".repeat(30);
    const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
    expect(redact(`push with ${gh} now`)).toBe("push with [secret removed] now");
    expect(redact(`key ${sk}`)).toBe("key [secret removed]");
    expect(redact(aws)).toBe("[secret removed]");
    expect(redact("Authorization: Bearer " + "t".repeat(30))).toBe("Authorization: Bearer [secret removed]");
    expect(redact("DB_PASSWORD=hunter22\nAPI_KEY: 'abcdef123'\nPORT=3000")).toBe("DB_PASSWORD=[secret removed]\nAPI_KEY: '[secret removed]'\nPORT=3000");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).toBe("[secret removed]");
    expect(redact("3 tests passed in src/a.ts; max_tokens: 4000")).toBe("3 tests passed in src/a.ts; max_tokens: 4000");
  });
});

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

describe("timeline from Claude's stream-json", () => {
  it("reads every reply, tool call and result, naming a result after its call (shapes seen live)", () => {
    const names = new Map<string, string>();
    const assistant = JSON.stringify({ type: "assistant", message: { content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Checking the tests first." },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test", description: "run tests" } },
    ] } });
    expect(fromClaudeStream(assistant, names)).toEqual([
      { kind: "assistant", text: "Checking the tests first." }, { kind: "tool", tool: "Bash", text: "npm test" },
    ]);
    const user = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "3 passing" }] }] } });
    expect(fromClaudeStream(user, names)).toEqual([{ kind: "result", tool: "Bash", text: "3 passing" }]);
    expect(fromClaudeStream(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([]);
    expect(fromClaudeStream(JSON.stringify({ type: "result", subtype: "success", result: "done" }))).toEqual([]);
    expect(fromClaudeStream("not json")).toBeNull();
    // Either agent's line is told apart.
    expect(fromStream(assistant)).toHaveLength(2);
    expect(fromStream('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}')).toEqual([{ kind: "assistant", text: "hi" }]);
    expect(readableOutput([assistant, "error: boom"])).toEqual(["Checking the tests first.", "$ npm test", "error: boom"]);
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
