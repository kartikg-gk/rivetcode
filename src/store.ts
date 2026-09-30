import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assertId } from "./paths.js";
import type { Node } from "./tree.js";

export type Run = {
  version: 1;
  id: string;
  repo: string;
  base: string;
  task: string;
  createdAt: string;
  nodes: Node[];
};

export class RunStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStoreError";
  }
}

export function newRunId(now: number = Date.now()): string {
  const rand = randomBytes(4).readUInt32BE(0).toString(36).padStart(4, "0").slice(-4);
  return `r${now.toString(36)}${rand}`;
}

export function runFile(repo: string, runId: string): string {
  assertId("run", runId);
  return join(repo, ".rivet", "runs", `${runId}.json`);
}

// Saves of the same run are queued so the last call always wins.
const queues = new Map<string, Promise<void>>();

// Write to a temp file and rename it over the old one, so a crash mid-write
// never leaves a half-written run file.
export function saveRun(run: Run): Promise<void> {
  const file = runFile(run.repo, run.id);
  // Serialize now: the caller may keep changing `run` while the save waits its turn.
  const text = JSON.stringify(run, null, 2) + "\n";
  const key = process.platform === "win32" ? file.toLowerCase() : file;
  const write = () => writeAtomically(file, text);
  const task = (queues.get(key) ?? Promise.resolve()).then(write, write);
  const tail = task.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return task;
}

async function writeAtomically(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, text);
    await renameWithRetry(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

// Windows refuses to replace a file another handle has open (a reader, an antivirus scan).
// Those locks are brief, so retry for a few seconds before giving up.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!busy || attempt >= 20) throw e;
      await sleep(25 * (attempt + 1));
    }
  }
}

export async function loadRun(repo: string, runId: string): Promise<Run> {
  const file = runFile(repo, runId);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new RunStoreError(`no run ${runId} (${file})`);
    throw e;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new RunStoreError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  const run = data as Partial<Run>;
  if (run?.version !== 1) throw new RunStoreError(`${file}: unsupported version ${String(run?.version)}`);
  if (run.id !== runId) throw new RunStoreError(`${file}: id ${String(run.id)} does not match file name`);
  if (!Array.isArray(run.nodes)) throw new RunStoreError(`${file}: nodes is not a list`);
  return run as Run;
}

export async function listRuns(repo: string): Promise<string[]> {
  const dir = join(repo, ".rivet", "runs");
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .sort();
}
