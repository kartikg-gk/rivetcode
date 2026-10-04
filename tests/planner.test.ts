import { describe, expect, it } from "vitest";
import {
  extractPlan, extractReplan, makePlan, planFiles, planPrompt, PlanError, renderPlan, type PlannerRunner,
} from "../src/planner/planner.js";

const good = { title: "api", prompt: "p", children: [
  { title: "routes", prompt: "make routes", files: ["src/routes.ts"] },
  { title: "models", prompt: "make models", files: ["src/models.ts"] },
] };

function scripted(...answers: string[]): PlannerRunner & { calls: { prompt: string; resume: boolean }[] } {
  const calls: { prompt: string; resume: boolean }[] = [];
  const run = (async (prompt: string, o: { resume: boolean }) => {
    calls.push({ prompt, resume: o.resume });
    return answers.shift() ?? "";
  }) as PlannerRunner & { calls: typeof calls };
  run.calls = calls;
  return run;
}

describe("extractPlan", () => {
  it("finds the JSON object in fenced or chatty output", () => {
    expect(extractPlan('Here you go:\n```json\n{"title":"a","prompt":"b {not a brace}"}\n```\nDone.')).toEqual({ title: "a", prompt: "b {not a brace}" });
  });

  it("explains missing or broken JSON", () => {
    expect(() => extractPlan("no json")).toThrow(/no JSON object/);
    expect(() => extractPlan('{"a": 1,}')).toThrow(/invalid JSON/);
    expect(() => extractPlan('{"a": {')).toThrow(/not closed/);
  });
});

describe("makePlan", () => {
  it("returns a valid plan on the first answer", async () => {
    const run = scripted(JSON.stringify(good));
    expect(await makePlan("build an api", run)).toEqual(good);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.prompt).toBe(planPrompt("build an api"));
  });

  it("gives the planner one fix attempt in the same conversation", async () => {
    const bad = { ...good, children: [...good.children, { title: "dup", prompt: "x", files: ["src/routes.ts"] }] };
    const run = scripted(JSON.stringify(bad), JSON.stringify(good));
    expect(await makePlan("t", run)).toEqual(good);
    expect(run.calls[1]).toMatchObject({ resume: true });
    expect(run.calls[1]!.prompt).toMatch(/both claim src\/routes\.ts/);
  });

  it("stops after one failed fix", async () => {
    const run = scripted("nothing", '{"title": 5}');
    await expect(makePlan("t", run)).rejects.toThrow(PlanError);
    expect(run.calls).toHaveLength(2);
  });

  it("checks depth and child limits in code", async () => {
    const deep = { title: "a", prompt: "p", children: [{ title: "b", prompt: "p", children: [{ title: "c", prompt: "p", children: [{ title: "d", prompt: "p" }] }] }] };
    await expect(makePlan("t", scripted(JSON.stringify(deep), JSON.stringify(deep)))).rejects.toThrow(/deeper than 3 levels/);
  });
});

describe("helpers", () => {
  it("lists every claimed file and renders a preview", () => {
    expect(planFiles(good)).toEqual(["src/routes.ts", "src/models.ts"]);
    expect(renderPlan(good, "claude")).toEqual([
      "root api  (integrates)",
      "  root.1 routes  (leaf, claude)  files: src/routes.ts",
      "  root.2 models  (leaf, claude)  files: src/models.ts",
    ]);
  });

  it("reads a re-plan answer", () => {
    expect(extractReplan('{"prompt": "do it this way"}')).toBe("do it this way");
    expect(() => extractReplan('{"other": 1}')).toThrow(/no new prompt/);
  });
});
