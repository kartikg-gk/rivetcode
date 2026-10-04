import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { git, GitError } from "./git.js";
import { isDirty } from "./worktree.js";

export async function headOf(worktree: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], worktree)).trim();
}

// Whatever an agent left uncommitted is saved, never thrown away.
export async function commitLeftovers(worktree: string, message: string): Promise<boolean> {
  if (!(await isDirty(worktree))) return false;
  await git(["add", "-A"], worktree);
  await git(["commit", "-q", "--no-verify", "-m", message], worktree);
  return true;
}

async function unmergedFiles(worktree: string): Promise<string[]> {
  const out = await git(["diff", "--name-only", "--diff-filter=U"], worktree);
  return out.split(/\r?\n/).filter(Boolean);
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[] };

// Always a merge commit, so each child's work stays visible in the parent's history.
export async function mergeBranch(worktree: string, branch: string, message: string): Promise<MergeResult> {
  try {
    await git(["merge", "--no-ff", "--no-edit", "-m", message, branch], worktree);
    return { ok: true };
  } catch (e) {
    const conflicts = await unmergedFiles(worktree).catch(() => []);
    if (e instanceof GitError && conflicts.length > 0) return { ok: false, conflicts };
    throw e;
  }
}

export async function abortMerge(worktree: string): Promise<void> {
  if (await mergeInProgress(worktree)) await git(["merge", "--abort"], worktree);
}

export async function mergeInProgress(worktree: string): Promise<boolean> {
  const gitDir = (await git(["rev-parse", "--absolute-git-dir"], worktree)).trim();
  return existsSync(join(gitDir, "MERGE_HEAD"));
}

const MARKER = /^(<{7}|>{7})( |$)|^={7}$/m;

export type Resolution = { ok: true } | { ok: false; reason: string };

// After an agent resolved a conflict: every conflicted file is clean, nothing else was
// touched (a parent only integrates), and the merge is committed.
export async function finishResolution(worktree: string, conflicted: string[]): Promise<Resolution> {
  const allowed = new Set(conflicted);
  const status = await git(["status", "--porcelain", "--untracked-files=all"], worktree);
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const path = line.slice(3).replace(/^"|"$/g, "");
    const staged = line[0] !== " " && line[0] !== "?";
    const touchedInTree = line[1] !== " ";
    // Auto-merged files arrive staged; any further edit outside the conflicts is feature work.
    if (!allowed.has(path) && (touchedInTree || !staged)) {
      return { ok: false, reason: `changed a file that was not in conflict: ${path}` };
    }
  }
  for (const file of conflicted) {
    const full = join(worktree, file);
    if (existsSync(full) && MARKER.test(await readFile(full, "utf8"))) {
      return { ok: false, reason: `conflict markers left in ${file}` };
    }
  }
  if (await mergeInProgress(worktree)) {
    await git(["add", "--", ...conflicted.filter((f) => existsSync(join(worktree, f)))], worktree);
    const missing = conflicted.filter((f) => !existsSync(join(worktree, f)));
    if (missing.length > 0) await git(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...missing], worktree);
    const left = await unmergedFiles(worktree);
    if (left.length > 0) return { ok: false, reason: `still unresolved: ${left.join(", ")}` };
    await git(["commit", "-q", "--no-verify", "--no-edit"], worktree);
  }
  if (await isDirty(worktree)) return { ok: false, reason: "worktree is not clean after resolving" };
  return { ok: true };
}

// Undoes a merge that failed its check. Refuses if anything is uncommitted.
export async function resetTo(worktree: string, commit: string): Promise<void> {
  if (await isDirty(worktree)) throw new Error(`not resetting ${worktree}: it has uncommitted work`);
  await git(["reset", "-q", "--hard", commit], worktree);
}

export type CommandResult = { ok: boolean; output: string };

const OUTPUT_LIMIT = 20_000;

// Ends a command and everything it started (a shell's children would otherwise
// keep running and keep the worktree busy).
function killTree(pid: number): void {
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

// Runs a user-configured check or test command through the shell, in the given worktree.
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32" });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, timeoutMs);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      if (timedOut) output += `
command timed out after ${timeoutMs} ms`;
      if (output.length > OUTPUT_LIMIT) output = "…" + output.slice(-OUTPUT_LIMIT);
      resolve({ ok: ok && !timedOut, output });
    };
    child.once("error", (e) => { output += e.message; finish(false); });
    child.once("close", (code) => finish(code === 0));
  });
}
