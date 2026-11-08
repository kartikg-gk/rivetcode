import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// Lowercase letters, digits, dot, dash, underscore. Must also be a valid git ref component.
const ID = /^[a-z0-9][a-z0-9._-]*$/;

export function assertId(kind: "run" | "node", id: string): void {
  if (!ID.test(id) || id.includes("..") || id.endsWith(".lock") || id.endsWith(".")) {
    throw new Error(`invalid ${kind} id: "${id}"`);
  }
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Project ids become folder names under the data dir, so no dot runs or separators.
export function assertProjectId(id: string): void {
  if (id === "" || id === "." || id.includes("..") || /[/\\]/.test(id) || !PROJECT_ID.test(id)) {
    throw new Error(`invalid project id: "${id}"`);
  }
}

export function projectIdFor(repo: string): string {
  return basename(resolve(repo)).toLowerCase().trim().replace(/ /g, "-");
}

// Everything Rivet keeps lives here, never inside the user's repo.
export function dataDir(): string {
  const override = process.env.RIVET_DATA_DIR;
  // Resolved once against the current folder, so a later chdir can't move it.
  if (override) return resolve(override);
  return join(homedir(), ".rivet", "data");
}

export function branchName(runId: string, nodeId: string): string {
  assertId("run", runId);
  assertId("node", nodeId);
  return `rivet/${runId}/${nodeId}`;
}

export function worktreePath(data: string, project: string, runId: string, nodeId: string): string {
  assertProjectId(project);
  assertId("run", runId);
  assertId("node", nodeId);
  return join(data, "worktrees", project, `${runId}-${nodeId}`);
}

// Windows paths are case-insensitive; compare them that way there.
export function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}
