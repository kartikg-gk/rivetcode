import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { git, GitError } from "./git.js";
import { samePath } from "./paths.js";

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
  // A lock means someone wants the worktree kept: leave it where it is and let git refuse.
  if (!registered.locked && (await removeThroughTrash(data, repo, full))) return;
  if (await isDirty(full)) throw new DirtyWorktreeError(full);
  await git(["worktree", "remove", full], repo);
}

// Deleting a big worktree is slow, renaming it is instant. So a clean worktree goes into
// the trash, git forgets it, and the files are deleted in the background.
// Returns false when this route could not be used and the worktree is back in place.
async function removeThroughTrash(data: string, repo: string, full: string): Promise<boolean> {
  const item = await moveToTrash(data, full);
  if (item === null) return false;

  // Judged after the move, so nothing can write into the tree between check and delete.
  const dirty = await isDirty(item.path).catch(() => null);
  const pruned = dirty === false && (await prune(repo).then(() => true, () => false));
  if (!pruned) {
    await item.putBack();
    if (dirty) throw new DirtyWorktreeError(full);
    return false;
  }

  // If git cannot be asked, the tree was clean anyway, so nothing uncommitted is lost.
  const stillKnown = await listWorktrees(repo).then(
    (list) => list.some((w) => samePath(w.path, full)),
    () => false,
  );
  if (stillKnown) {
    await item.putBack();
    throw new WorktreeError(`refusing to remove ${full}: git still lists it after pruning`);
  }
  item.purge();
  return true;
}

type TrashItem = { path: string; putBack(): Promise<void>; purge(): void };

function trashDir(data: string): string {
  return join(data, "worktrees", ".trash");
}

// Each removal gets its own fresh slot folder, so two removals never pick the same name.
async function moveToTrash(data: string, full: string): Promise<TrashItem | null> {
  let slot: string;
  try {
    await mkdir(trashDir(data), { recursive: true });
    slot = await mkdtemp(join(trashDir(data), `${basename(full)}-`));
  } catch {
    return null;
  }
  const path = join(slot, "tree");
  try {
    await rename(full, path);
  } catch {
    await rmdir(slot).catch(() => {});
    return null;
  }
  return {
    path,
    putBack: async () => {
      await rename(path, full).catch(() => {});
      await rmdir(slot).catch(() => {});
    },
    purge: () => deleteLater(slot),
  };
}

const pendingDeletes = new Set<Promise<void>>();

function deleteLater(path: string): void {
  const job: Promise<void> = rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    .catch(() => {})
    .finally(() => pendingDeletes.delete(job));
  pendingDeletes.add(job);
}

// Deletes whatever an earlier process left in the trash. Call once at startup.
export async function emptyTrash(data: string): Promise<void> {
  const names = await readdir(trashDir(data)).catch(() => [] as string[]);
  for (const name of names) deleteLater(join(trashDir(data), name));
}

// Waits for background deletes; tests and shutdown use this.
export async function waitForTrash(): Promise<void> {
  await Promise.all([...pendingDeletes]);
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent) + sep;
  return process.platform === "win32"
    ? c.toLowerCase().startsWith(p.toLowerCase())
    : c.startsWith(p);
}
