import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { git, GitError } from "./git.js";
import { samePath } from "./paths.js";
import { recordedLinks, unlinkAll } from "./links.js";

export type Worktree = {
  path: string;
  branch: string | null;
  head: string;
  prunable: boolean;
  locked: boolean;
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

// Removing or pruning rewrites a repo's shared worktree records while other git commands
// read them. Queue creation and teardown together per repo inside this process so an
// add cannot inspect another registration while remove/prune is changing it.
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
  // Creation reads the shared registration directory too.
  return withRepoLock(o.repo, () => create(o));
}

async function create(o: { repo: string; path: string; branch: string; from: string }): Promise<Worktree> {
  const path = resolve(o.path);
  if (existsSync(path)) throw new WorktreeError(`path already exists: ${path}`);
  if (await branchExists(o.repo, o.branch)) {
    throw new WorktreeError(`branch already exists: ${o.branch}`);
  }
  await mkdir(dirname(path), { recursive: true });
  // Branch first, checkout second: if checkout fails we know the branch is ours to delete.
  await git(["branch", o.branch, o.from], o.repo);
  try {
    try {
      await git(["worktree", "add", path, o.branch], o.repo);
    } catch (e) {
      // A record left by a worktree deleted by hand blocks its path. Pruning only
      // then keeps the usual create to one git call instead of two.
      if (!(e instanceof GitError) || !/already registered|missing but/i.test(e.stderr)) throw e;
      await prune(o.repo);
      await git(["worktree", "add", path, o.branch], o.repo);
    }
  } catch (e) {
    await prune(o.repo).catch(() => {});
    await git(["branch", "-D", o.branch], o.repo).catch(() => {});
    throw e;
  }
  const head = (await git(["rev-parse", "HEAD"], path)).trim();
  // Canonical case and long names, matching what git records and listWorktrees returns.
  return { path: await realpath(path), branch: o.branch, head, prunable: false, locked: false };
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  const out = await git(["worktree", "list", "--porcelain"], repo);
  const list: Worktree[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) continue;
    const wt: Worktree = { path: "", branch: null, head: "", prunable: false, locked: false };
    for (const line of lines) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "worktree") wt.path = resolve(value);
      else if (key === "HEAD") wt.head = value;
      else if (key === "branch") wt.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "prunable") wt.prunable = true;
      else if (key === "locked") wt.locked = true;
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
export function removeWorktree(data: string, repo: string, path: string): Promise<void> {
  return withRepoLock(repo, () => remove(data, repo, path));
}

async function remove(data: string, repo: string, path: string): Promise<void> {
  const full = existsSync(path) ? await realpath(path) : resolve(path);
  const home = join(data, "worktrees");
  if (!isInside(full, home)) throw new WorktreeError(`path is outside ${home}, not removing: ${full}`);

  const registered = (await listWorktrees(repo)).find((w) => samePath(w.path, full));
  if (!existsSync(full)) {
    if (registered) await prune(repo);
    return;
  }
  if (!registered) {
    // An earlier removal unregistered it but could not delete the folder.
    if ((await readdir(full)).length > 0) throw new WorktreeError(`not a worktree of this repo, not removing: ${full}`);
    await rmdir(full);
    return;
  }
  // Checked first, so a refused worktree keeps its links.
  if (await isDirty(full)) throw new DirtyWorktreeError(full);
  // Links come out before git deletes anything: git worktree remove on Windows follows a
  // junction and empties the folder it points at.
  await unlinkAll(full, await recordedLinks(full));
  const refused = await git(["worktree", "remove", full], repo).then(() => null, (e: Error) => e);
  await prune(repo);
  if ((await listWorktrees(repo)).some((w) => samePath(w.path, full))) {
    throw new WorktreeError(`refusing to remove ${full}: git still lists it${refused ? ` (${refused.message.trim()})` : ""}`);
  }
  // Whatever git left behind (files it does not track).
  await rm(full, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// Earlier versions moved removed worktrees into a trash folder; deletes what is left there.
export async function emptyTrash(data: string): Promise<void> {
  await rm(join(data, "worktrees", ".trash"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent) + sep;
  return process.platform === "win32"
    ? c.toLowerCase().startsWith(p.toLowerCase())
    : c.startsWith(p);
}
