import { expect, it } from "vitest";
import { terminalRepliesFromTranscript } from "../src/claude-terminal-history.js";

it("imports intermediate replies from the latest turn and ignores duplicate and child records", () => {
  const user = (content: unknown) => ({ type: "user", message: { content } });
  const reply = (id: string, text: string) => ({ type: "assistant", message: { id, content: [{ type: "text", text }] } });
  const records = [user("old task"), reply("old", "old answer"), user("current task"), reply("a", "first reply"),
    reply("a", "first reply"), user([{ type: "tool_result" }]), { ...reply("child", "child reply"), isSidechain: true }, reply("b", "final reply")];
  const timeline = terminalRepliesFromTranscript(records.map(record => JSON.stringify(record)).join("\n"), "final reply");
  expect(timeline.map(item => item.text)).toEqual(["first reply", "final reply"]);
});
