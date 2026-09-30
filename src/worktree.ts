import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { git, GitError } from "./git.js";
import { ensureExcluded, samePath } from "./paths.js";

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

// git reads every worktree's admin folder while adding or removing one, so concurrent
// changes to the same repo can fail. Changes are queued per repo inside this process.
const queues = new Map<string, Promise<unknown>>();

async function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const common = resolve(repo, (await git(["rev-parse", "--git-common-dir"], repo)).trim());
  const key = process.platform === "win32" ? common.toLowerCase() : common;
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

async function prune(repo: string): Promise<void> {
  await git(["worktree", "prune"], repo);
}

export function createWorktree(o: {
  repo: string;
  path: string;
  branch: string;
  from: string;
}): Promise<Worktree> {
  return withRepoLock(o.repo, () => create(o));
}

async function create(o: { repo: string; path: string; branch: string; from: string }): Promise<Worktree> {
  const path = resolve(o.path);
  if (existsSync(path)) throw new WorktreeError(`path already exists: ${path}`);
  if (await branchExists(o.repo, o.branch)) {
    throw new WorktreeError(`branch already exists: ${o.branch}`);
  }
  await ensureExcluded(o.repo);
  await mkdir(dirname(path), { recursive: true });
  // Drops records of worktree directories deleted by hand, which would block this path.
  await prune(o.repo);
  // Branch first, checkout second: if checkout fails we know the branch is ours to delete.
  await git(["branch", o.branch, o.from], o.repo);
  try {
    await git(["worktree", "add", path, o.branch], o.repo);
  } catch (e) {
    await prune(o.repo).catch(() => {});
    await git(["branch", "-D", o.branch], o.repo).catch(() => {});
    throw e;
  }
  const head = (await git(["rev-parse", "HEAD"], path)).trim();
  // Canonical case and long names, matching what git records and listWorktrees returns.
  return { path: await realpath(path), branch: o.branch, head, prunable: false };
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
  // Inside a checkout but not at a worktree root, git status would report the enclosing repo.
  const top = (await git(["rev-parse", "--show-toplevel"], path)).trim();
  if (!samePath(top, await realpath(path))) {
    throw new WorktreeError(`not a worktree root: ${path}`);
  }
  const out = await git(["status", "--porcelain", "--untracked-files=all"], path);
  return out.trim() !== "";
}

export function pruneWorktrees(repo: string): Promise<void> {
  return withRepoLock(repo, () => prune(repo));
}

// Never passes --force: a dirty worktree may hold an agent's only copy of its work.
export function removeWorktree(repo: string, path: string): Promise<void> {
  return withRepoLock(repo, () => remove(repo, path));
}

async function remove(repo: string, path: string): Promise<void> {
  const full = existsSync(path) ? await realpath(path) : resolve(path);
  const registered = (await listWorktrees(repo)).some((w) => samePath(w.path, full));
  if (!existsSync(full)) {
    if (registered) await prune(repo);
    return;
  }
  if (!registered) {
    // Left behind when an earlier removal unregistered the worktree but could not delete the folder.
    if ((await readdir(full)).length === 0) {
      await rmdir(full);
      return;
    }
    throw new WorktreeError(`not a worktree of this repo, not removing: ${full}`);
  }
  if (await isDirty(full)) throw new DirtyWorktreeError(full);
  await git(["worktree", "remove", full], repo);
}

const DEFAULT_LOCK_AGE_MS = 5 * 60 * 1000;

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent) + sep;
  return process.platform === "win32"
    ? c.toLowerCase().startsWith(p.toLowerCase())
    : c.startsWith(p);
}

// Only locks Rivet can reason about: its own worktrees, its own branches, and packed-refs.
// The main checkout's index.lock is left alone: an open commit-message editor holds it
// for as long as the user takes to write the message.
async function lockCandidates(repo: string, commonDir: string): Promise<string[]> {
  const files = [join(commonDir, "packed-refs.lock")];
  const nodeRoot = join(repo, ".rivet", "wt");
  const wtRoot = join(commonDir, "worktrees");
  for (const name of await readdir(wtRoot).catch(() => [] as string[])) {
    const gitdir = await readFile(join(wtRoot, name, "gitdir"), "utf8").catch(() => "");
    if (!gitdir.trim() || !isInside(gitdir.trim(), nodeRoot)) continue;
    files.push(join(wtRoot, name, "index.lock"), join(wtRoot, name, "HEAD.lock"));
  }
  const rivetRefs = join(commonDir, "refs", "heads", "rivet");
  const refs = await readdir(rivetRefs, { recursive: true }).catch(() => [] as string[]);
  for (const rel of refs) {
    if (rel.endsWith(".lock")) files.push(join(rivetRefs, rel));
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
  const main = (await listWorktrees(repo))[0]!.path;
  const commonDir = resolve(repo, (await git(["rev-parse", "--git-common-dir"], repo)).trim());
  const removed: string[] = [];
  for (const file of await lockCandidates(main, commonDir)) {
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (now - info.mtimeMs <= maxAgeMs) continue;
    // Re-check just before deleting: another cleaner or a new git may have replaced it.
    const again = await stat(file).catch(() => null);
    if (!again || again.ino !== info.ino || again.mtimeMs !== info.mtimeMs) continue;
    try {
      await unlink(file);
      removed.push(resolve(file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return removed;
}
