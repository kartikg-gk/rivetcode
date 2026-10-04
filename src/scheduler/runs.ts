import { realpath } from "node:fs/promises";
import { git } from "../git.js";
import { assertProjectId, defaultProjectId } from "../paths.js";
import { newRunId, type Run } from "../store.js";
import { buildTree, TreeError, AGENTS, type Agent, type PlanNode } from "../tree.js";
import { createWorktree, DirtyWorktreeError, removeWorktree } from "../worktree.js";

export class RunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunInputError";
  }
}

export type NewRun = {
  data: string;
  repo: string;
  task: string;
  plan: PlanNode;
  base?: string;
  agent?: string;
  // The project's configured default agent, used when no agent is given.
  defaultAgentFor?(project: string): string | undefined;
};

async function repoRoot(dir: string): Promise<string> {
  try {
    return await realpath((await git(["rev-parse", "--show-toplevel"], dir)).trim());
  } catch {
    throw new RunInputError(`not a git repository: ${dir}`);
  }
}

// Builds the tree and gives every node its worktree: the root branches from the base,
// every child from its parent's branch. Nothing is left behind if a step fails.
export async function prepareRun(o: NewRun): Promise<Run> {
  if (!o.task.trim()) throw new RunInputError("task is empty");
  const repo = await repoRoot(o.repo);
  const base = o.base?.trim() || (await git(["rev-parse", "--abbrev-ref", "HEAD"], repo)).trim();
  try {
    await git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], repo);
  } catch {
    throw new RunInputError(`base "${base}" is not a commit in ${repo}`);
  }
  const project = defaultProjectId(repo);
  try { assertProjectId(project); } catch (e) { throw new RunInputError((e as Error).message); }
  const agent = (o.agent ?? o.defaultAgentFor?.(project) ?? "claude") as Agent;
  if (!AGENTS.includes(agent)) throw new RunInputError(`unknown agent "${o.agent}"`);

  const id = newRunId();
  let nodes;
  try {
    nodes = buildTree({ runId: id, project, dataDir: o.data, plan: o.plan, defaultAgent: agent });
  } catch (e) {
    if (e instanceof TreeError) throw new RunInputError(e.message);
    throw e;
  }

  const made: { path: string; branch: string }[] = [];
  try {
    for (const n of nodes) {
      const from = n.parentId === null ? base : nodes.find((p) => p.id === n.parentId)!.branch;
      await createWorktree({ repo, path: n.worktree, branch: n.branch, from });
      made.push({ path: n.worktree, branch: n.branch });
    }
  } catch (e) {
    for (const m of made.reverse()) {
      await removeWorktree(o.data, repo, m.path).catch(() => {});
      await git(["branch", "-D", m.branch], repo).catch(() => {});
    }
    throw e;
  }
  return { id, project, repo, base, task: o.task.trim(), createdAt: new Date().toISOString(), nodes };
}

// Removes a run's worktrees. Branches stay (they hold the work); dirty worktrees stay too.
export async function cleanRun(data: string, run: Run): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const n of [...run.nodes].reverse()) {
    try {
      await removeWorktree(data, run.repo, n.worktree);
      removed.push(n.id);
    } catch (e) {
      if (e instanceof DirtyWorktreeError) kept.push(n.id);
      else throw e;
    }
  }
  return { removed, kept };
}
