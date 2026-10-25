import type { TaskSpec } from "./tasks.js";
import { existsSync } from "node:fs";
import { cp, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { git } from "../git.js";
import { runCommand } from "../merge.js";
import { assertProjectId, branchName, defaultProjectId, worktreePath } from "../paths.js";
import { newRunId, type Run } from "../store.js";
import { AGENTS, NODE_ID, ROLES, type Agent, type Role } from "../model.js";
import { createWorktree, DirtyWorktreeError, removeWorktree } from "../worktree.js";
import { LinkError, linkListed } from "../links.js";

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
  role?: Role;
  // A short label for lists; at most 100 characters.
  name?: string;
  // The orchestrator session that asked for this worker.
  orchestrator?: string;
  model?: string;
  issue?: number;
  spec?: TaskSpec;
  base?: string;
  agent?: string;
  // The project's configured default agent, used when no agent is given.
  defaultAgentFor?(project: string): string | undefined;
  // Untracked files to copy from the repo into every worktree (e.g. .env).
  copyFor?(project: string): string[];
  // Ignored folders to link from the main checkout instead of copying (e.g. node_modules).
  linkFor?(project: string): string[];
  // Shell commands run in every new worktree, in order (e.g. "npm ci").
  setupFor?(project: string): string[];
};

// Model names that plainly belong to one agent, so the other is never started with them.
export const MODEL_FAMILIES: Record<string, RegExp> = { claude: /^(claude|opus|sonnet|haiku)/i, codex: /^(gpt|o\d|codex)/i };

// The main checkout, also when asked from inside a linked worktree (an agent's own), so
// a new session never starts from another session's worktree.
export async function repoRoot(dir: string): Promise<string> {
  try {
    const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir)).trim();
    if (basename(common) === ".git") return await realpath(dirname(common));
    return await realpath((await git(["rev-parse", "--show-toplevel"], dir)).trim());
  } catch {
    throw new RunInputError(`not a git repository: ${dir}`);
  }
}

// One session with its own worktree and branch, started from the base. Nothing is left
// behind if a step fails.
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
  const role = o.role ?? "worker";
  if (!ROLES.includes(role)) throw new RunInputError(`unknown role "${String(role)}"`);
  const otherFamily = MODEL_FAMILIES[agent === "claude" ? "codex" : "claude"];
  if (o.model && agent !== "fake" && otherFamily.test(o.model.trim())) {
    throw new RunInputError(`model "${o.model.trim()}" is not a ${agent} model; leave --model off to use ${agent}'s default`);
  }
  const name = (o.name ?? "").trim();
  if (name.length > 100) throw new RunInputError(`name is ${name.length} characters; at most 100`);

  const id = newRunId();
  const node = {
    id: NODE_ID, title: name || o.task.trim().split(/\r?\n/)[0]!.slice(0, 100), prompt: o.task.trim(), agent,
    branch: branchName(id, NODE_ID), worktree: worktreePath(o.data, project, id, NODE_ID),
    status: "pending" as const, attempts: 0,
  };
  await createWorktree({ repo, path: node.worktree, branch: node.branch, from: base });
  try {
    await copyListed(repo, node.worktree, o.copyFor?.(project) ?? []);
    try {
      await linkListed(repo, node.worktree, o.linkFor?.(project) ?? []);
    } catch (e) {
      if (e instanceof LinkError) throw new RunInputError(e.message);
      throw e;
    }
    // The worktree is provisioned (e.g. dependencies installed) before its agent starts.
    const steps = o.setupFor?.(project) ?? [];
    if (steps.length > 0) await runSetup(repo, node.worktree, id, steps);
  } catch (e) {
    await removeWorktree(o.data, repo, node.worktree).catch(() => {});
    await git(["branch", "-D", node.branch], repo).catch(() => {});
    throw e;
  }
  return {
    id, project, repo, base, task: o.task.trim(), createdAt: new Date().toISOString(), role, name,
    ...(o.orchestrator ? { orchestrator: o.orchestrator } : {}), ...(o.model?.trim() ? { model: o.model.trim() } : {}), ...(o.issue ? { issue: o.issue } : {}), ...(o.spec && Object.keys(o.spec).length ? { spec: o.spec } : {}), node,
  };
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

// Removes a run's worktree. The branch stays (it holds the work); a dirty worktree stays too.
export async function cleanRun(data: string, run: Run): Promise<{ removed: string[]; kept: string[] }> {
  try {
    await removeWorktree(data, run.repo, run.node.worktree);
    return { removed: [run.node.id], kept: [] };
  } catch (e) {
    if (e instanceof DirtyWorktreeError) return { removed: [], kept: [run.node.id] };
    throw e;
  }
}
