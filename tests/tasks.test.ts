import { describe, expect, it } from "vitest";
import { globMatch, outsidePaths, parseTaskFile } from "../src/scheduler/tasks.js";

const yaml = `
defaults:
  agent: claude
  limits: { attempts: 3 }
tasks:
  - name: add CSV export
    goal: export the report table as CSV
    done_when: npm test -- export
    agent: codex
    limits: { minutes: 30, tokens: 2000000 }
    guardrails:
      paths: [src/export/**, tests/export/**]
      deny_tools: ["Bash(npm publish:*)"]
  - goal: fix date parsing
`;

describe("task files", () => {
  it("reads tasks with their goal, done_when, limits and guardrails, defaults filling the rest", () => {
    const [csv, dates] = parseTaskFile(yaml, "tasks.yaml");
    expect(csv).toEqual({
      name: "add CSV export", goal: "export the report table as CSV", agent: "codex",
      spec: { doneWhen: "npm test -- export", minutes: 30, tokens: 2000000, attempts: 3, paths: ["src/export/**", "tests/export/**"], denyTools: ["Bash(npm publish:*)"] },
    });
    expect(dates).toEqual({ name: "fix date parsing", goal: "fix date parsing", agent: "claude", spec: { attempts: 3 } });
    expect(parseTaskFile('[{"goal": "x"}]', "t.json")).toEqual([{ name: "x", goal: "x", spec: {} }]);
  });

  it("says what is wrong with a bad file", () => {
    expect(() => parseTaskFile("tasks: []", "t.yaml")).toThrow(/has no tasks/);
    expect(() => parseTaskFile("- name: x", "t.yaml")).toThrow(/task 1 needs a goal/);
    expect(() => parseTaskFile("- goal: x\n  limits: { minutes: -1 }", "t.yaml")).toThrow(/task 1.limits.minutes must be a positive number/);
    expect(() => parseTaskFile("- goal: x\n  limits: { attempts: 1.5 }", "t.yaml")).toThrow(/whole number/);
    expect(() => parseTaskFile("- goal: x\n  budget: 3", "t.yaml")).toThrow(/unknown field "budget"/);
    expect(() => parseTaskFile("- goal: [", "t.yaml")).toThrow(/cannot be read/);
  });
});

describe("path globs", () => {
  it("matches ** across folders, * within one, ? one character", () => {
    expect(globMatch("src/export/**", "src/export/a/b.ts")).toBe(true);
    expect(globMatch("src/export/**", "src/exporter.ts")).toBe(false);
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/x/a.ts")).toBe(false);
    expect(globMatch("**/*.md", "README.md")).toBe(true);
    expect(globMatch("a?.txt", "ab.txt")).toBe(true);
    expect(outsidePaths(["src/export/x.ts", "package.json"], ["src/export/**"])).toEqual(["package.json"]);
  });
});
