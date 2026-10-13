import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usageLine } from "../src/cli/commands.js";
import { claudeSessionTokens, codexSessionTokens, NO_TOKENS } from "../src/usage.js";
import { makeDataDir, removeRepo } from "./helpers.js";

let dir: string;
beforeEach(async () => { dir = await makeDataDir(); });
afterEach(async () => { await removeRepo(dir); });

const tokenCount = (input: number, cached: number, output: number) => JSON.stringify({
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output } } },
});

describe("usage", () => {
  it("reads a Codex session's last running total, with the cached part split out", async () => {
    const day = join(dir, "2026", "10", "13");
    await mkdir(day, { recursive: true });
    await writeFile(join(day, "rollout-2026-10-13T10-00-00-abc-123.jsonl"), [
      JSON.stringify({ type: "session_meta" }), tokenCount(1000, 600, 50), tokenCount(3000, 2000, 120), "",
    ].join("\n"));
    expect(codexSessionTokens("abc-123", dir)).toEqual({ input: 1000, cacheWrite: 0, cacheRead: 2000, output: 120 });
    expect(codexSessionTokens("missing", dir)).toEqual(NO_TOKENS);
  });

  it("counts each streamed Claude message once", async () => {
    await mkdir(join(dir, "folder"), { recursive: true });
    const msg = (id: string, out: number) => JSON.stringify({ message: { id, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: out } } });
    await writeFile(join(dir, "folder", "s1.jsonl"), [msg("m1", 1), msg("m1", 7), msg("m2", 3)].join("\n"));
    expect(claudeSessionTokens("s1", dir)).toEqual({ input: 20, cacheWrite: 10, cacheRead: 200, output: 10 });
  });

  it("prints tokens, not a price", () => {
    expect(usageLine({ conversations: 3, tokens: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 } }))
      .toBe("usage: 10 tokens over 3 agent conversations (input 1, cache write 2, cache read 3, output 4)");
  });
});
