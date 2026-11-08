import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// running.json records which process owns Rivet's state, so a second daemon can
// refuse to start instead of fighting the first over git and the database.
export type RunInfo = {
  pid: number;
  port: number;
  startedAt: string;
};

export function runFileAt(): string {
  const override = process.env.RIVET_RUN_FILE;
  if (override) return resolve(override);
  return join(homedir(), ".rivet", "running.json");
}

// Temp file + rename, so a reader never sees half a file.
export async function writeRunFile(path: string, info: RunInfo): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.running-${randomBytes(4).toString("hex")}.json`);
  try {
    await writeFile(tmp, JSON.stringify(info, null, 2) + "\n");
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

// A missing file is the normal "no daemon recorded" state.
export async function readRunFile(path: string): Promise<RunInfo | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`read run file: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as RunInfo;
  } catch (e) {
    throw new Error(`parse run file ${path}: ${(e as Error).message}`);
  }
}

// Only the owner removes it, so a daemon shutting down never deletes its successor's file.
export async function releaseRunFile(path: string, ownerPid: number): Promise<void> {
  const info = await readRunFile(path);
  if (!info || info.pid !== ownerPid) return;
  await rm(path, { force: true });
}

// Returns the recorded owner if that process is still alive, otherwise null
// (no file, or one left by a process that died).
export async function liveOwner(path: string): Promise<RunInfo | null> {
  const info = await readRunFile(path);
  if (!info || !(info.pid > 0)) return null;
  return isAlive(info.pid) ? info : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
