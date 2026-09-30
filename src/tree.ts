import { posix } from "node:path";
import { branchName, worktreePath } from "./paths.js";

export type Agent = "claude" | "codex";
export type Status =
  | "pending" | "running" | "integrating" | "done" | "failed" | "escalated" | "skipped";

export type PlanNode = {
  title: string;
  prompt: string;
  files?: string[];
  agent?: Agent;
  children?: PlanNode[];
};

export type Node = {
  id: string;
  parentId: string | null;
  depth: number;
  kind: "leaf" | "parent";
  title: string;
  prompt: string;
  files: string[];
  agent: Agent;
  branch: string;
  worktree: string;
  status: Status;
  attempts: number;
  summary?: string;
};

// Every level adds a parent that waits on its children, so the tree stays shallow.
export const MAX_LEVELS = 3;
export const MAX_CHILDREN = 4;

export class TreeError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid plan:\n${problems.join("\n")}`);
    this.name = "TreeError";
  }
}

// Repo-relative, forward slashes, no "." / ".." segments, no trailing slash.
function normalizeFile(f: string): string {
  return posix.normalize(f.trim().replace(/\\/g, "/")).replace(/\/+$/, "");
}

// A claim must name something inside the repo, literally (no globs).
function isValidFile(f: unknown): f is string {
  if (typeof f !== "string") return false;
  const raw = f.trim().replace(/\\/g, "/");
  if (raw === "" || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return false;
  if (/[*?[\]{}]/.test(raw)) return false;
  const n = normalizeFile(raw);
  return n !== "" && n !== "." && n !== ".." && !n.startsWith("../");
}

// Every claim covers its whole subtree: "src" and "src/a.ts" overlap.
function claimsOverlap(a: string, b: string): boolean {
  const [x, y] = process.platform === "win32" ? [a.toLowerCase(), b.toLowerCase()] : [a, b];
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
}

function subtreeFiles(p: PlanNode): string[] {
  const own = (p.files ?? []).filter(isValidFile).map(normalizeFile);
  return [...own, ...(p.children ?? []).flatMap(subtreeFiles)];
}

export function validatePlan(plan: PlanNode): string[] {
  const problems: string[] = [];
  const visit = (p: PlanNode, id: string, depth: number) => {
    if (depth >= MAX_LEVELS) {
      problems.push(`${id} is deeper than ${MAX_LEVELS} levels`);
      return;
    }
    if (!p.title?.trim()) problems.push(`${id} has an empty title`);
    if (!p.prompt?.trim()) problems.push(`${id} has an empty prompt`);
    for (const f of p.files ?? []) {
      if (!isValidFile(f)) problems.push(`${id} has invalid file "${String(f)}"`);
    }
    const children = p.children ?? [];
    if (children.length > MAX_CHILDREN) {
      problems.push(`${id} has ${children.length} children (max ${MAX_CHILDREN})`);
    }
    const claims = children.map(subtreeFiles);
    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const clash = claims[i]!.find((a) => claims[j]!.some((b) => claimsOverlap(a, b)));
        if (clash !== undefined) {
          problems.push(`${id}.${i + 1} and ${id}.${j + 1} both claim ${clash}`);
        }
      }
    }
    children.forEach((c, i) => visit(c, `${id}.${i + 1}`, depth + 1));
  };
  visit(plan, "root", 0);
  return problems;
}

export function buildTree(o: {
  runId: string;
  repo: string;
  plan: PlanNode;
  defaultAgent: Agent;
}): Node[] {
  const problems = validatePlan(o.plan);
  if (problems.length > 0) throw new TreeError(problems);
  const nodes: Node[] = [];
  const visit = (p: PlanNode, id: string, parentId: string | null, depth: number) => {
    const children = p.children ?? [];
    nodes.push({
      id,
      parentId,
      depth,
      kind: children.length > 0 ? "parent" : "leaf",
      title: p.title.trim(),
      prompt: p.prompt,
      files: (p.files ?? []).map(normalizeFile),
      agent: p.agent ?? o.defaultAgent,
      branch: branchName(o.runId, id),
      worktree: worktreePath(o.repo, o.runId, id),
      status: "pending",
      attempts: 0,
    });
    children.forEach((c, i) => visit(c, `${id}.${i + 1}`, id, depth + 1));
  };
  visit(o.plan, "root", null, 0);
  return nodes;
}

const TRANSITIONS: Record<Node["kind"], Partial<Record<Status, Status[]>>> = {
  leaf: {
    pending: ["running", "skipped"],
    running: ["done", "failed", "escalated", "skipped"],
    failed: ["running", "escalated", "skipped"],
    escalated: ["running", "skipped"],
  },
  parent: {
    pending: ["integrating"],
    integrating: ["done", "failed", "escalated"],
    failed: ["integrating", "escalated"],
    escalated: ["integrating"],
  },
};

export function setStatus(nodes: Node[], id: string, to: Status, summary?: string): Node[] {
  const i = nodes.findIndex((n) => n.id === id);
  if (i < 0) throw new Error(`unknown node ${id}`);
  const n = nodes[i]!;
  if (!(TRANSITIONS[n.kind][n.status] ?? []).includes(to)) {
    throw new Error(`${id} (${n.kind}) cannot go from ${n.status} to ${to}`);
  }
  const working = to === "running" || to === "integrating";
  const next: Node = {
    ...n,
    status: to,
    attempts: working ? n.attempts + 1 : n.attempts,
    ...(summary !== undefined ? { summary } : {}),
  };
  return nodes.map((x, j) => (j === i ? next : x));
}
