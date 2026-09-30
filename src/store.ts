import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

// Write to a temp file and rename it over the old one, so a crash mid-write
// never leaves a half-written run file.
export async function saveRun(run: Run): Promise<void> {
  const file = runFile(run.repo, run.id);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(run, null, 2) + "\n");
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
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
