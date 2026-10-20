import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killRuleVerdict, runBench, type ModeResult } from "../src/bench/bench.js";
import { claudeSessionTokens } from "../src/usage.js";
import type { PlanNode } from "../src/tree.js";
import { makeDataDir, makeRepo, removeRepo } from "./helpers.js";

let repo: string;
let work: string;
beforeEach(async () => { repo = await makeRepo(); work = await makeDataDir(); });
afterEach(async () => { await removeRepo(repo); await removeRepo(work); });

const leaf = (title: string, spec: object): PlanNode => ({ title, prompt: JSON.stringify(spec), agent: "fake" });

describe("runBench", () => {
  it("runs each mode in its own clone and reports a verdict", async () => {
    const result = await runBench({
      name: "two files", repo, task: "add a and b", test: `node -e "require('fs').accessSync('a.txt'); require('fs').accessSync('b.txt')"`,
      modes: {
        single: leaf("both", { files: { "a.txt": "a", "b.txt": "b" }, commit: "both" }),
        flat: { title: "root", prompt: "r", children: [
          leaf("a", { files: { "a.txt": "a" }, commit: "a" }), leaf("b", { files: { "b.txt": "b" }, commit: "b" }),
        ] },
        tree: { title: "root", prompt: "r", children: [
          { title: "group", prompt: "g", children: [leaf("a", { files: { "a.txt": "a" }, commit: "a" })] },
          leaf("b", { files: { "b.txt": "b" }, commit: "b" }),
        ] },
      },
    }, { workDir: work });
    expect(result.results.map((r) => [r.mode, r.passed, r.leaves])).toEqual([
      ["single", true, 1], ["flat", true, 2], ["tree", true, 2],
    ]);
    expect(result.verdict).toMatch(/^kill rule: /);
  }, 120_000);

  it("a mode whose test fails does not pass", async () => {
    const result = await runBench({
      name: "fails", repo, task: "t", test: `node -e "process.exit(1)"`,
      modes: { flat: { title: "root", prompt: "r", children: [leaf("a", { files: { "a.txt": "a" }, commit: "a" })] } },
    }, { workDir: work });
    expect(result.results[0]).toMatchObject({ passed: false, rootStatus: "failed" });
    expect(result.verdict).toMatch(/not decided/);
  }, 60_000);
});

describe("killRuleVerdict", () => {
  const r = (mode: string, over: Partial<ModeResult>): ModeResult => ({
    mode, runId: "r", rootStatus: "done", passed: true, seconds: 100, leaves: 2, attempts: 2, escalations: 0, conflicts: 0,
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, inputEquivalent: 0, ...over,
  });
  it("keeps the tree only when it passes and is no slower, with no more conflicts", () => {
    expect(killRuleVerdict([r("flat", {}), r("tree", { seconds: 105 })])).toMatch(/tree beats flat/);
    expect(killRuleVerdict([r("flat", {}), r("tree", { seconds: 130 })])).toMatch(/does NOT beat/);
    expect(killRuleVerdict([r("flat", {}), r("tree", { conflicts: 1 })])).toMatch(/does NOT beat/);
    expect(killRuleVerdict([r("flat", { passed: false }), r("tree", { seconds: 500 })])).toMatch(/tree beats flat/);
    expect(killRuleVerdict([r("flat", {}), r("tree", { passed: false })])).toMatch(/does NOT beat/);
  });
});

describe("claudeSessionTokens", () => {
  it("sums each streamed message once", async () => {
    const root = join(work, "projects");
    await mkdir(join(root, "some-folder"), { recursive: true });
    const line = (id: string, out: number) => JSON.stringify({ message: { id, usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: out } } });
    await writeFile(join(root, "some-folder", "s1.jsonl"), [line("m1", 5), line("m1", 5), line("m2", 7), "{}", "not json"].join("\n"));
    expect(claudeSessionTokens("s1", root)).toEqual({ input: 2, cacheWrite: 20, cacheRead: 200, output: 12 });
    expect(claudeSessionTokens("missing", root)).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });
});
