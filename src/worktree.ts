import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  await git(["worktree", "add", "-b", o.branch, path, o.from], o.repo);
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
