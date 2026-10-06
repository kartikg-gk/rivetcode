import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS, buildTree, PR_STATUSES, setStatus, TreeError, validatePlan, type PlanNode } from "../src/tree.js";

const leaf = (title: string, files: string[] = []): PlanNode => ({ title, prompt: `do ${title}`, files });
const data = join("C:", "data x");

describe("buildTree", () => {
  it("builds a single-leaf (flat) run", () => {
    const nodes = buildTree({ runId: "r1", project: "proj", dataDir: data, plan: leaf("fix bug"), defaultAgent: "claude" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: "root", parentId: null, depth: 0, kind: "leaf", agent: "claude",
      branch: "rivet/r1/root", worktree: join(data, "worktrees", "proj", "r1-root"),
      status: "pending", attempts: 0, files: [],
    });
  });

  it("numbers nodes in pre-order and links parents", () => {
    const plan: PlanNode = {
      title: "login", prompt: "integrate",
      children: [leaf("db", ["db/"]), { title: "api", prompt: "integrate api", children: [leaf("routes", ["api/routes.ts"]), leaf("auth", ["api/auth.ts"])] }],
    };
    const nodes = buildTree({ runId: "r1", project: "proj", dataDir: data, plan, defaultAgent: "codex" });
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
    const nodes = buildTree({ runId: "r1", project: "proj", dataDir: data, plan, defaultAgent: "claude" });
    expect(nodes.map((n) => n.agent)).toEqual(["claude", "codex", "claude"]);
  });

  it("throws TreeError listing every problem", () => {
    const plan: PlanNode = { title: "", prompt: "p", children: [leaf("a", ["x.ts"]), leaf("b", ["x.ts"])] };
    const err = (() => { try { buildTree({ runId: "r1", project: "proj", dataDir: data, plan, defaultAgent: "claude" }); } catch (e) { return e; } })();
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

describe("setStatus", () => {
  const plan: PlanNode = { title: "r", prompt: "p", children: [leaf("a"), leaf("b")] };
  const fresh = () => buildTree({ runId: "r1", project: "proj", dataDir: data, plan, defaultAgent: "claude" });

  it("moves a leaf through a retry and counts attempts", () => {
    let nodes = fresh();
    nodes = setStatus(nodes, "root.1", "running");
    nodes = setStatus(nodes, "root.1", "failed");
    nodes = setStatus(nodes, "root.1", "running");
    nodes = setStatus(nodes, "root.1", "done", "added table");
    const n = nodes.find((x) => x.id === "root.1")!;
    expect(n).toMatchObject({ status: "done", attempts: 2, summary: "added table" });
  });

  it("does not mutate the input", () => {
    const nodes = fresh();
    setStatus(nodes, "root.1", "running");
    expect(nodes[1]!.status).toBe("pending");
  });

  it("parents integrate, they never run", () => {
    expect(() => setStatus(fresh(), "root", "running")).toThrow(/root.*parent.*pending.*running/);
    const n = setStatus(fresh(), "root", "integrating").find((x) => x.id === "root")!;
    expect(n).toMatchObject({ status: "integrating", attempts: 1 });
  });

  it("rejects leaving a final state", () => {
    let nodes = setStatus(setStatus(fresh(), "root.1", "running"), "root.1", "done");
    expect(() => setStatus(nodes, "root.1", "running")).toThrow(/done.*running/);
    nodes = setStatus(fresh(), "root.2", "skipped");
    expect(() => setStatus(nodes, "root.2", "running")).toThrow(/skipped/);
  });

  it("a parent waits between merges", () => {
    let nodes = setStatus(fresh(), "root", "waiting");
    nodes = setStatus(nodes, "root", "integrating");
    nodes = setStatus(nodes, "root", "waiting");
    nodes = setStatus(nodes, "root", "integrating");
    nodes = setStatus(nodes, "root", "done");
    expect(nodes[0]).toMatchObject({ status: "done", attempts: 2 });
    expect(() => setStatus(fresh(), "root.1", "waiting")).toThrow(/leaf.*pending.*waiting/);
  });

  it("an escalated parent can wait again once the user has fixed things", () => {
    let nodes = setStatus(setStatus(fresh(), "root", "integrating"), "root", "escalated");
    nodes = setStatus(nodes, "root", "waiting");
    expect(nodes[0]!.status).toBe("waiting");
  });

  it("rejects an unknown node", () => {
    expect(() => setStatus(fresh(), "root.9", "running")).toThrow(/unknown node root\.9/);
  });
});

describe("file claims", () => {
  const pair = (a: string[], b: string[]): PlanNode => ({ title: "r", prompt: "p", children: [leaf("a", a), leaf("b", b)] });

  it.each([
    [["src"], ["src/a.ts"]],
    [["src"], ["src/"]],
    [["src//a.ts"], ["src/a.ts"]],
    [["src/./a.ts"], ["src/a.ts"]],
    [["src/x/../a.ts"], ["src/a.ts"]],
  ])("treats %j and %j as the same claim", (a, b) => {
    expect(validatePlan(pair(a, b))).toEqual([expect.stringMatching(/both claim/)]);
  });

  it.runIf(process.platform === "win32")("ignores case on Windows", () => {
    expect(validatePlan(pair(["SRC/a.ts"], ["src/a.ts"]))).toEqual([expect.stringMatching(/both claim/)]);
  });

  it.each(["../x", "a/../../b", "C:\\x", "/etc/passwd", "", "   ", ".", "./", "src/*.ts", "src/[ab].ts"])(
    "rejects file %j",
    (f) => {
      const plan: PlanNode = { title: "r", prompt: "p", children: [leaf("a", [f])] };
      expect(validatePlan(plan)).toEqual([`root.1 has invalid file "${f}"`]);
    },
  );
});

describe("state lists", () => {
  it("has every PR status the root can report", () => {
    expect([...PR_STATUSES].sort()).toEqual([
      "approved", "changes_requested", "ci_failed", "draft", "exited", "idle", "mergeable",
      "merged", "needs_input", "no_signal", "pr_open", "review_pending", "terminated", "working",
    ]);
  });
});

describe("agents", () => {
  it("includes the fake agent for end-to-end runs", () => {
    expect([...AGENTS]).toEqual(["claude", "codex", "fake"]);
  });
});
