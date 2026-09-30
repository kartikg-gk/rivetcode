import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { git } from "./git.js";

// Lowercase letters, digits, dot, dash, underscore. Must also be a valid git ref component.
const ID = /^[a-z0-9][a-z0-9._-]*$/;

export function assertId(kind: "run" | "node", id: string): void {
  if (!ID.test(id) || id.includes("..") || id.endsWith(".lock") || id.endsWith(".")) {
    throw new Error(`invalid ${kind} id: "${id}"`);
  }
}

export function branchName(runId: string, nodeId: string): string {
  assertId("run", runId);
  assertId("node", nodeId);
  return `rivet/${runId}/${nodeId}`;
}

export function worktreePath(repo: string, runId: string, nodeId: string): string {
  assertId("run", runId);
  assertId("node", nodeId);
  return join(repo, ".rivet", "wt", runId, nodeId);
}

const EXCLUDE_LINE = ".rivet/";

// Uses info/exclude so the user's own .gitignore is never touched.
export async function ensureExcluded(repo: string): Promise<void> {
  const rel = (await git(["rev-parse", "--git-path", "info/exclude"], repo)).trim();
  const file = resolve(repo, rel);
  const current = await readFile(file, "utf8").catch(() => "");
  if (current.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
  await mkdir(dirname(file), { recursive: true });
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${sep}${EXCLUDE_LINE}\n`);
}

// Windows paths are case-insensitive; compare them that way there.
export function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}
