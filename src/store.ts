import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assertId, branchName, ensureExcluded, samePath, worktreePath } from "./paths.js";
import { AGENTS, KINDS, STATUSES, type Node } from "./tree.js";

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
  const write = () => writeAtomically(run.repo, file, text);
  const task = (queues.get(key) ?? Promise.resolve()).then(write, write);
  const tail = task.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return task;
}

async function writeAtomically(repo: string, file: string, text: string): Promise<void> {
  await ensureExcluded(repo);
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
  const problem = checkRun(run as Run, repo);
  if (problem) throw new RunStoreError(`${file}: ${problem}`);
  return run as Run;
}

const isString = (v: unknown): v is string => typeof v === "string";

// Later steps run git on these branches and paths, so a hand-edited file must not
// be able to point them anywhere else.
function checkRun(run: Run, repo: string): string | null {
  if (!isString(run.repo) || !samePath(run.repo, repo)) return `repo ${String(run.repo)} is not ${repo}`;
  for (const key of ["base", "task", "createdAt"] as const) {
    if (!isString(run[key])) return `${key} is missing or not text`;
  }
  const ids = new Set<string>();
  for (const [i, n] of run.nodes.entries()) {
    if (typeof n !== "object" || n === null) return `node ${i} is not an object`;
    try {
      assertId("node", n.id);
    } catch {
      return `node ${i} has an invalid id ${String(n.id)}`;
    }
    ids.add(n.id);
  }
  for (const n of run.nodes) {
    const where = `node ${n.id}`;
    if (!(KINDS as readonly string[]).includes(n.kind)) return `${where} has unknown kind ${String(n.kind)}`;
    if (!(STATUSES as readonly string[]).includes(n.status)) return `${where} has unknown status ${String(n.status)}`;
    if (!(AGENTS as readonly string[]).includes(n.agent)) return `${where} has unknown agent ${String(n.agent)}`;
    if (!Number.isInteger(n.attempts) || n.attempts < 0) return `${where} has invalid attempts ${String(n.attempts)}`;
    if (n.parentId !== null && !ids.has(n.parentId)) return `${where} has unknown parent ${String(n.parentId)}`;
    if (n.branch !== branchName(run.id, n.id)) return `${where} has unexpected branch ${String(n.branch)}`;
    if (!isString(n.worktree) || !samePath(n.worktree, worktreePath(repo, run.id, n.id))) {
      return `${where} has unexpected worktree ${String(n.worktree)}`;
    }
    if (!isString(n.title) || !isString(n.prompt) || !Array.isArray(n.files) || !n.files.every(isString)) {
      return `${where} has a missing title, prompt or files`;
    }
  }
  return null;
}

export async function listRuns(repo: string): Promise<string[]> {
  const dir = join(repo, ".rivet", "runs");
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .sort();
}
