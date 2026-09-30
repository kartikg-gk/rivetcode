import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTree, TreeError, validatePlan, type PlanNode } from "../src/tree.js";

const leaf = (title: string, files: string[] = []): PlanNode => ({ title, prompt: `do ${title}`, files });
const repo = join("C:", "repo x");

describe("buildTree", () => {
  it("builds a single-leaf (flat) run", () => {
    const nodes = buildTree({ runId: "r1", repo, plan: leaf("fix bug"), defaultAgent: "claude" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: "root", parentId: null, depth: 0, kind: "leaf", agent: "claude",
      branch: "rivet/r1/root", worktree: join(repo, ".rivet", "wt", "r1", "root"),
      status: "pending", attempts: 0, files: [],
    });
  });

  it("numbers nodes in pre-order and links parents", () => {
    const plan: PlanNode = {
      title: "login", prompt: "integrate",
      children: [leaf("db", ["db/"]), { title: "api", prompt: "integrate api", children: [leaf("routes", ["api/routes.ts"]), leaf("auth", ["api/auth.ts"])] }],
    };
    const nodes = buildTree({ runId: "r1", repo, plan, defaultAgent: "codex" });
    expect(nodes.map((n) => [n.id, n.parentId, n.depth, n.kind])).toEqual([
      ["root", null, 0, "parent"],
      ["root.1", "root", 1, "leaf"],
      ["root.2", "root", 1, "parent"],
      ["root.2.1", "root.2", 2, "leaf"],
      ["root.2.2", "root.2", 2, "leaf"],
    ]);
    expect(nodes[3]!.branch).toBe("rivet/r1/root.2.1");
  });

  it("uses a node's own agent over the default", () => {
    const plan: PlanNode = { title: "t", prompt: "p", children: [{ ...leaf("a"), agent: "codex" }, leaf("b")] };
    const nodes = buildTree({ runId: "r1", repo, plan, defaultAgent: "claude" });
    expect(nodes.map((n) => n.agent)).toEqual(["claude", "codex", "claude"]);
  });

  it("throws TreeError listing every problem", () => {
    const plan: PlanNode = { title: "", prompt: "p", children: [leaf("a", ["x.ts"]), leaf("b", ["x.ts"])] };
    const err = (() => { try { buildTree({ runId: "r1", repo, plan, defaultAgent: "claude" }); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(TreeError);
    expect((err as TreeError).problems).toHaveLength(2);
  });
});

describe("validatePlan", () => {
  it("accepts exactly 3 levels", () => {
    const plan: PlanNode = { title: "r", prompt: "p", children: [{ title: "m", prompt: "p", children: [leaf("l")] }] };
    expect(validatePlan(plan)).toEqual([]);
  });

  it("rejects a 4th level and names the node", () => {
    const deep: PlanNode = { title: "r", prompt: "p", children: [{ title: "m", prompt: "p", children: [{ title: "too deep", prompt: "p", children: [leaf("x")] }] }] };
    expect(validatePlan(deep)).toEqual([expect.stringMatching(/root\.1\.1\.1.*3 levels/)]);
  });

  it("rejects more than 4 children and names the parent", () => {
    const plan: PlanNode = { title: "r", prompt: "p", children: ["a", "b", "c", "d", "e"].map((t) => leaf(t)) };
    expect(validatePlan(plan)).toEqual([expect.stringMatching(/root has 5 children.*max 4/)]);
  });

  it("rejects empty titles and prompts", () => {
    const plan: PlanNode = { title: "r", prompt: "p", children: [{ title: " ", prompt: "" }] };
    expect(validatePlan(plan)).toEqual([
      expect.stringMatching(/root\.1.*title/),
      expect.stringMatching(/root\.1.*prompt/),
    ]);
  });

  it.each([
    [["./src/a.ts"], ["src/a.ts"]],
    [["src\\a.ts"], ["src/a.ts"]],
    [["src/"], ["src/a.ts"]],
    [["src/a.ts"], ["src/"]],
  ])("detects sibling overlap %j vs %j", (a, b) => {
    const plan: PlanNode = { title: "r", prompt: "p", children: [leaf("a", a), leaf("b", b)] };
    expect(validatePlan(plan)).toEqual([expect.stringMatching(/root\.1 and root\.2 both claim/)]);
  });

  it("compares whole subtrees, not just direct children", () => {
    const plan: PlanNode = {
      title: "r", prompt: "p",
      children: [leaf("a", ["x.ts"]), { title: "m", prompt: "p", children: [leaf("b", ["x.ts"])] }],
    };
    expect(validatePlan(plan)).toEqual([expect.stringMatching(/root\.1 and root\.2 both claim x\.ts/)]);
  });

  it("allows different files and similar prefixes", () => {
    const plan: PlanNode = { title: "r", prompt: "p", children: [leaf("a", ["src/a.ts"]), leaf("b", ["src/ab.ts", "srcx/"])] };
    expect(validatePlan(plan)).toEqual([]);
  });
});
