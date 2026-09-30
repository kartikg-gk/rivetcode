import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { git, GitError } from "./git.js";
import { ensureExcluded } from "./paths.js";

export type Worktree = {
  path: string;
  branch: string | null;
  head: string;
  prunable: boolean;
};

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo);
    return true;
  } catch (e) {
    if (e instanceof GitError && e.code === 1) return false;
    throw e;
  }
}

export async function createWorktree(o: {
  repo: string;
  path: string;
  branch: string;
  from: string;
}): Promise<Worktree> {
  const path = resolve(o.path);
  if (existsSync(path)) throw new WorktreeError(`path already exists: ${path}`);
  if (await branchExists(o.repo, o.branch)) {
    throw new WorktreeError(`branch already exists: ${o.branch}`);
  }
  await ensureExcluded(o.repo);
  await mkdir(dirname(path), { recursive: true });
  // Drops records of worktree directories deleted by hand, which would block this path.
  await pruneWorktrees(o.repo);
  // Branch first, checkout second: if checkout fails we know the branch is ours to delete.
  await git(["branch", o.branch, o.from], o.repo);
  try {
    await git(["worktree", "add", path, o.branch], o.repo);
  } catch (e) {
    await pruneWorktrees(o.repo).catch(() => {});
    await git(["branch", "-D", o.branch], o.repo).catch(() => {});
    throw e;
  }
  const head = (await git(["rev-parse", "HEAD"], path)).trim();
  return { path, branch: o.branch, head, prunable: false };
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const out = await git(["worktree", "list", "--porcelain"], repo);
  const list: Worktree[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) continue;
    const wt: Worktree = { path: "", branch: null, head: "", prunable: false };
    for (const line of lines) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") wt.path = resolve(value);
      else if (key === "HEAD") wt.head = value;
      else if (key === "branch") wt.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "prunable") wt.prunable = true;
    }
    list.push(wt);
  }
  return list;
}

export class DirtyWorktreeError extends WorktreeError {
  constructor(path: string) {
    super(`worktree has uncommitted or untracked changes, not removing: ${path}`);
    this.name = "DirtyWorktreeError";
  }
}

export async function isDirty(path: string): Promise<boolean> {
  const out = await git(["status", "--porcelain", "--untracked-files=all"], path);
  return out.trim() !== "";
}

export async function pruneWorktrees(repo: string): Promise<void> {
  await git(["worktree", "prune"], repo);
}

// Never passes --force: a dirty worktree may hold an agent's only copy of its work.
export async function removeWorktree(repo: string, path: string): Promise<void> {
  const full = resolve(path);
  if (!existsSync(full)) {
    await pruneWorktrees(repo);
    return;
  }
  if (await isDirty(full)) throw new DirtyWorktreeError(full);
  await git(["worktree", "remove", full], repo);
}

const DEFAULT_LOCK_AGE_MS = 5 * 60 * 1000;

async function lockCandidates(commonDir: string): Promise<string[]> {
  const files = [join(commonDir, "index.lock"), join(commonDir, "HEAD.lock")];
  const wtRoot = join(commonDir, "worktrees");
  for (const name of await readdir(wtRoot).catch(() => [] as string[])) {
    files.push(join(wtRoot, name, "index.lock"), join(wtRoot, name, "HEAD.lock"));
  }
  const refs = await readdir(join(commonDir, "refs"), { recursive: true }).catch(() => [] as string[]);
  for (const rel of refs) {
    if (rel.endsWith(".lock")) files.push(join(commonDir, "refs", rel));
  }
  return files;
}

// A git lock left behind by a killed process blocks every later git command.
// Only locks older than maxAgeMs are removed; a younger one may belong to a running git.
export async function clearStaleLocks(
  repo: string,
  opts: { maxAgeMs?: number; now?: number } = {},
): Promise<string[]> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_LOCK_AGE_MS;
  const now = opts.now ?? Date.now();
  const commonDir = resolve(repo, (await git(["rev-parse", "--git-common-dir"], repo)).trim());
  const removed: string[] = [];
  for (const file of await lockCandidates(commonDir)) {
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (now - info.mtimeMs <= maxAgeMs) continue;
    await unlink(file);
    removed.push(resolve(file));
  }
  return removed;
}
