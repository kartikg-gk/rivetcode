import { existsSync } from "node:fs";
import { cp, mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git } from "../git.js";
import { runCommand } from "../merge.js";
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
  // Untracked files to copy from the repo into every worktree (e.g. .env).
  copyFor?(project: string): string[];
  // Shell commands run in every new worktree, in order (e.g. "npm ci").
  setupFor?(project: string): string[];
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
      await copyListed(repo, n.worktree, o.copyFor?.(project) ?? []);
      made.push({ path: n.worktree, branch: n.branch });
    }
    // Every worktree is provisioned (e.g. dependencies installed) before any agent starts.
    const steps = o.setupFor?.(project) ?? [];
    if (steps.length > 0) await Promise.all(nodes.map((n) => runSetup(repo, n.worktree, n.id, steps)));
  } catch (e) {
    for (const m of made.reverse()) {
      await removeWorktree(o.data, repo, m.path).catch(() => {});
      await git(["branch", "-D", m.branch], repo).catch(() => {});
    }
    throw e;
  }
  return { id, project, repo, base, task: o.task.trim(), createdAt: new Date().toISOString(), nodes };
}

// Only the listed files, never everything untracked; a missing one is skipped. They are
// local files git does not track, so they go away with the worktree.
async function copyListed(repo: string, worktree: string, files: string[]): Promise<void> {
  for (const file of files) {
    const rel = file.trim().replace(/\\/g, "/");
    if (!rel || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.split("/").includes("..")) {
      throw new RunInputError(`copy entry must be a path inside the repo: "${file}"`);
    }
    const from = join(repo, rel);
    if (!existsSync(from)) continue;
    // A copied file that git tracks or would add could end up committed (a .env with secrets).
    try {
      await git(["check-ignore", "-q", "--no-index", rel], repo);
    } catch {
      throw new RunInputError(`copy only takes files git ignores; "${rel}" is not ignored`);
    }
    await mkdir(dirname(join(worktree, rel)), { recursive: true });
    await cp(from, join(worktree, rel), { recursive: true });
  }
}

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

const SETUP_STEP_TIMEOUT_MS = 10 * 60_000;
const SETUP_OUTPUT_TAIL = 8 * 1024;

// Each step through the shell in the worktree, ten minutes at most; the first failure
// stops the run before any agent starts, showing the end of its output.
async function runSetup(repo: string, worktree: string, nodeId: string, steps: string[]): Promise<void> {
  for (const [i, step] of steps.entries()) {
    const result = await runCommand(step, worktree, SETUP_STEP_TIMEOUT_MS, {
      RIVET_SOURCE_TREE_PATH: repo,
      RIVET_WORKTREE_PATH: worktree,
    });
    if (!result.ok) {
      throw new SetupError(`setup step ${i + 1} ("${step}") failed in ${nodeId}:\n${result.output.trim().slice(-SETUP_OUTPUT_TAIL)}`);
    }
  }
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
