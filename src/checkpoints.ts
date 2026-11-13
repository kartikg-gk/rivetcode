import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { git } from "./git.js";

// Filesystem checkpoints: before each prompt a chat session takes, the worktree's files
// (tracked and untracked, ignored ones left out) are saved as a commit under a hidden ref.
// Nothing is staged, committed on a branch or changed in the worktree by taking one. Line
// endings are stored and restored as found (no autocrlf conversion), so files come back byte for byte.
// Rolling a conversation back with its files puts the worktree back to that commit.

const PREFIX = "refs/rivet/checkpoints";
const IDENTITY = { GIT_AUTHOR_NAME: "Rivet", GIT_AUTHOR_EMAIL: "rivet@localhost", GIT_COMMITTER_NAME: "Rivet", GIT_COMMITTER_EMAIL: "rivet@localhost" };

export const checkpointName = (itemId: string) => itemId.replace(/[^A-Za-z0-9._-]/g, "-");
export function checkpointRef(runId: string, itemId: string): string {
  return `${PREFIX}/${runId}/${checkpointName(itemId)}`;
}

// A private index, so the real one (and what is staged in it) is never touched.
async function scratchIndex(cwd: string): Promise<string> {
  const p = (await git(["rev-parse", "--git-path", `rivet-checkpoint-${process.pid}-${Date.now()}.index`], cwd)).trim();
  return isAbsolute(p) ? p : join(cwd, p);
}

// The worktree's files as a tree, without touching the real index.
async function snapshotTree(cwd: string): Promise<string> {
  const index = await scratchIndex(cwd);
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = await git(["rev-parse", "--verify", "-q", "HEAD"], cwd).then((s) => s.trim(), () => "");
    if (head) await git(["read-tree", head], cwd, env);
    await git(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "add", "-A", "--", "."], cwd, env);
    return (await git(["write-tree"], cwd, env)).trim();
  } finally {
    await rm(index, { force: true });
  }
}

export async function captureCheckpoint(cwd: string, ref: string): Promise<string> {
  const tree = await snapshotTree(cwd);
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"], cwd).then((s) => s.trim(), () => "");
  const commit = (await git(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `rivet checkpoint ${ref}`], cwd, IDENTITY)).trim();
  await git(["update-ref", ref, commit], cwd);
  return commit;
}

export async function hasCheckpoint(cwd: string, ref: string): Promise<boolean> {
  return git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], cwd).then(() => true, () => false);
}

// Put the worktree's files back as the checkpoint saved them: files made since are removed,
// changed and deleted ones restored. The branch, its commits and the real index stay as they are.
export async function restoreCheckpoint(cwd: string, ref: string): Promise<{ restored: number; removed: number }> {
  const saved = (await git(["rev-parse", "--verify", `${ref}^{tree}`], cwd)).trim();
  const now = await snapshotTree(cwd);
  const changed = (await git(["diff", "--name-status", "-z", "--no-renames", saved, now], cwd)).split("\0").filter(Boolean);
  const added: string[] = [];
  let restored = 0;
  for (let i = 0; i + 1 < changed.length; i += 2) {
    if (changed[i] === "A") added.push(changed[i + 1]!);
    else restored++;
  }
  for (const file of added) await rm(join(cwd, file), { force: true });
  const index = await scratchIndex(cwd);
  try {
    await git(["read-tree", saved], cwd, { GIT_INDEX_FILE: index });
    await git(["-c", "core.autocrlf=false", "checkout-index", "-a", "-f"], cwd, { GIT_INDEX_FILE: index });
  } finally {
    await rm(index, { force: true });
  }
  return { restored, removed: added.length };
}

// Every checkpoint of a run, for removal with it.
export async function dropCheckpoints(cwd: string, runId: string): Promise<number> {
  const refs = (await git(["for-each-ref", "--format=%(refname)", `${PREFIX}/${runId}/`], cwd)).split(/\r?\n/).filter(Boolean);
  for (const ref of refs) await git(["update-ref", "-d", ref], cwd);
  return refs.length;
}

// One changed file in a diff: lines added and removed (binary files count none).
export type FileChange = { path: string; added: number; removed: number; binary: boolean };

export function parseNumstat(out: string): FileChange[] {
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [a, r, ...rest] = line.split("\t");
    const binary = a === "-";
    return { path: rest.join("\t"), added: binary ? 0 : Number(a), removed: binary ? 0 : Number(r), binary };
  });
}

// What one turn changed: the files as they were before its prompt against the files before
// the next prompt, or against the worktree now when no prompt came after it.
export async function checkpointDiff(cwd: string, fromRef: string, toRef?: string): Promise<{ diff: string; files: FileChange[] }> {
  const from = (await git(["rev-parse", "--verify", `${fromRef}^{tree}`], cwd)).trim();
  const to = toRef ? (await git(["rev-parse", "--verify", `${toRef}^{tree}`], cwd)).trim() : await snapshotTree(cwd);
  const [diff, numstat] = await Promise.all([
    git(["-c", "core.autocrlf=false", "diff", from, to], cwd),
    git(["-c", "core.autocrlf=false", "diff", "--numstat", from, to], cwd),
  ]);
  return { diff, files: parseNumstat(numstat) };
}

// Every checkpoint of a session at once, item id to commit: one git call however long the chat.
export async function listCheckpoints(cwd: string, runId: string): Promise<Map<string, string>> {
  const prefix = `${PREFIX}/${runId}/`;
  const out = await git(["for-each-ref", "--format=%(objectname) %(refname)", prefix], cwd).catch(() => "");
  const found = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const at = line.indexOf(" ");
    if (at > 0) found.set(line.slice(at + 1 + prefix.length), line.slice(0, at));
  }
  return found;
}

// Lines changed between two checkpoint commits, or since one when no second is given.
// Two saved checkpoints never change, so their counts are kept.
const statCache = new Map<string, FileChange[]>();
export async function checkpointStat(cwd: string, from: string, to?: string): Promise<FileChange[]> {
  const key = to ? `${from}:${to}` : "";
  const kept = key ? statCache.get(key) : undefined;
  if (kept) return kept;
  const toTree = to ? `${to}^{tree}` : await snapshotTree(cwd);
  const files = parseNumstat(await git(["-c", "core.autocrlf=false", "diff", "--numstat", `${from}^{tree}`, toTree], cwd));
  if (key) {
    if (statCache.size > 5000) statCache.clear();
    statCache.set(key, files);
  }
  return files;
}
