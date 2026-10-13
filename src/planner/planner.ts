import { MAX_CHILDREN, MAX_LEVELS, validatePlan, type PlanNode } from "../tree.js";

// Something that answers a planning prompt with text (a headless agent in real use).
// resume: continue the same conversation, used for the one fix attempt.
export type PlannerRunner = (prompt: string, o: { resume: boolean }) => Promise<string>;

export function planPrompt(task: string): string {
  return [
    "You are planning work for several coding agents that will run in parallel, each in its own git worktree.",
    `Task: ${task}`,
    "",
    "Read the repository (read-only) to understand it, then split the task into a tree of subtasks:",
    `- At most ${MAX_LEVELS} levels (root, its children, their children). At most ${MAX_CHILDREN} children per node.`,
    "- Leaves do the coding; parents only merge their children. Keep the tree as small as the task allows;",
    "  a task that one agent can do well should be a single leaf (just the root, no children).",
    "- Siblings must be independent: work that depends on other work goes in the same leaf.",
    "- Every leaf prompt must be self-contained: what to build, where, and how to verify it.",
    "- List the files each leaf will create or change in \"files\". Siblings must not share files",
    "  (a folder claims everything below it).",
    "- A file that several parts would each need to edit (an index that exports every part, a",
    "  registry, a router) goes in its parent's \"shared\" list, never in a leaf. No leaf edits it;",
    "  each leaf tests its code by importing it from its own file. The parent wires the shared files",
    "  once all its parts are merged.",
    "",
    "Answer with only one JSON object, no other text, of this shape:",
    '{"title": "...", "prompt": "...", "shared": ["..."], "children": [ { "title": "...", "prompt": "...", "files": ["..."] } ]}',
  ].join("\n");
}

function fixPrompt(problems: string[]): string {
  return [
    "That plan breaks these rules:",
    ...problems.map((p) => `- ${p}`),
    "Answer again with only the corrected JSON object.",
  ].join("\n");
}

// The first balanced {...} in the text, also inside a ```json fence.
export function extractPlan(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("the planner returned no JSON object");
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch (e) {
        throw new Error(`the planner returned invalid JSON: ${(e as Error).message}`);
      }
    }
  }
  throw new Error("the planner's JSON object is not closed");
}

function shapeProblems(value: unknown, id = "root"): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${id} is not an object`];
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof v.title !== "string") problems.push(`${id} needs a "title" string`);
  if (typeof v.prompt !== "string") problems.push(`${id} needs a "prompt" string`);
  for (const key of ["files", "shared"]) {
    if (v[key] !== undefined && !(Array.isArray(v[key]) && (v[key] as unknown[]).every((f) => typeof f === "string"))) {
      problems.push(`${id} "${key}" must be a list of strings`);
    }
  }
  if (v.children !== undefined) {
    if (!Array.isArray(v.children)) problems.push(`${id} "children" must be a list`);
    else v.children.forEach((c, i) => problems.push(...shapeProblems(c, `${id}.${i + 1}`)));
  }
  return problems;
}

function check(value: unknown): { plan?: PlanNode; problems: string[] } {
  const shape = shapeProblems(value);
  if (shape.length > 0) return { problems: shape };
  const plan = value as PlanNode;
  return { plan, problems: validatePlan(plan) };
}

export class PlanError extends Error {
  constructor(message: string, readonly problems: string[]) {
    super(message);
    this.name = "PlanError";
  }
}

// Asks for a plan, checks every rule in code, allows one fix attempt, then gives up.
export async function makePlan(task: string, run: PlannerRunner): Promise<PlanNode> {
  let text = await run(planPrompt(task), { resume: false });
  let result: { plan?: PlanNode; problems: string[] };
  try { result = check(extractPlan(text)); } catch (e) { result = { problems: [(e as Error).message] }; }
  if (result.problems.length === 0) return result.plan!;
  text = await run(fixPrompt(result.problems), { resume: true });
  try { result = check(extractPlan(text)); } catch (e) { result = { problems: [(e as Error).message] }; }
  if (result.problems.length === 0) return result.plan!;
  throw new PlanError(`the planner's plan is still invalid after one fix attempt:\n${result.problems.join("\n")}`, result.problems);
}

// For the failure ladder: new instructions for a leaf that failed twice.
export function replanPrompt(task: string, leaf: { title: string; prompt: string; files: string[] }, why: string): string {
  return [
    `A coding agent failed twice on one part of the task: ${task}`,
    `Part: ${leaf.title}`,
    "Its instructions were:",
    leaf.prompt,
    leaf.files.length ? `Files: ${leaf.files.join(", ")}` : "",
    "",
    "What went wrong:",
    why,
    "",
    "Read the repository (read-only) and write better, self-contained instructions for this part,",
    "addressing the failure. Answer with only: {\"prompt\": \"...\"}",
  ].join("\n");
}

export function extractReplan(text: string): string {
  const value = extractPlan(text) as { prompt?: unknown };
  if (typeof value.prompt !== "string" || !value.prompt.trim()) throw new Error("the planner returned no new prompt");
  return value.prompt;
}

// Every file a subtree claims, for the overlap warning.
export function planFiles(plan: PlanNode): string[] {
  return [...(plan.files ?? []), ...(plan.children ?? []).flatMap(planFiles)];
}

export function renderPlan(plan: PlanNode, defaultAgent: string): string[] {
  const lines: string[] = [];
  const visit = (p: PlanNode, id: string, depth: number) => {
    const kids = p.children ?? [];
    const role = kids.length > 0 ? "integrates" : `leaf, ${p.agent ?? defaultAgent}`;
    lines.push(`${"  ".repeat(depth)}${id} ${p.title}  (${role})${p.files?.length ? `  files: ${p.files.join(", ")}` : ""}${p.shared?.length ? `  wires: ${p.shared.join(", ")}` : ""}`);
    kids.forEach((c, i) => visit(c, `${id}.${i + 1}`, depth + 1));
  };
  visit(plan, "root", 0);
  return lines;
}
