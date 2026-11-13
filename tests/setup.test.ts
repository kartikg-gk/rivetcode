import { describe, expect, it } from "vitest";
import { checkAgent } from "../src/setup.js";

describe("the setup check", () => {
  it("says an agent that is missing must be installed", async () => {
    const saved = process.env.RIVET_CODEX_BIN;
    process.env.RIVET_CODEX_BIN = "Z:/nowhere/codex.exe";
    try {
      const codex = await checkAgent("codex", async () => ({ ok: true, out: "" }));
      expect(codex).toMatchObject({ installed: false, loggedIn: false, login: "codex login" });
      expect(codex.problem).toContain("points at nothing");
    } finally {
      if (saved === undefined) delete process.env.RIVET_CODEX_BIN; else process.env.RIVET_CODEX_BIN = saved;
    }
  });

  it("reads whether Claude and Codex are logged in", async () => {
    const saved = { c: process.env.RIVET_CLAUDE_BIN, x: process.env.RIVET_CODEX_BIN };
    process.env.RIVET_CLAUDE_BIN = process.execPath;
    process.env.RIVET_CODEX_BIN = process.execPath;
    try {
      const out = (status: string) => async (_f: string, args: string[]) => (args[0] === "--version" ? { ok: true, out: "1.0.0" } : { ok: !/false|Not/.test(status), out: status });
      expect((await checkAgent("claude", out('{"loggedIn": true}'))).loggedIn).toBe(true);
      expect((await checkAgent("claude", out('{"loggedIn": false}'))).loggedIn).toBe(false);
      expect((await checkAgent("codex", out("Logged in using ChatGPT"))).loggedIn).toBe(true);
      const out2 = await checkAgent("codex", out("Not logged in"));
      expect(out2).toMatchObject({ installed: true, loggedIn: false, problem: "Codex is not logged in", version: "1.0.0" });
    } finally {
      for (const [k, v] of [["RIVET_CLAUDE_BIN", saved.c], ["RIVET_CODEX_BIN", saved.x]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
