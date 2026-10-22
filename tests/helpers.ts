import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.js";
import { NODE_ID } from "../src/model.js";
import { branchName, worktreePath } from "../src/paths.js";
import type { Run } from "../src/store.js";

// The space in the prefix is deliberate: real repos often live under paths with spaces.
export async function makeRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "rivet test ")));
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  await git(["config", "user.name", "Rivet Test"], dir);
  await git(["config", "commit.gpgsign", "false"], dir);
  await writeFile(join(dir, "README.txt"), "hello\n");
  await git(["add", "."], dir);
  await git(["commit", "-m", "init"], dir);
  return dir;
}

export async function removeRepo(dir: string): Promise<void> {
  // Windows can hold a folder for a moment after the process inside it exits.
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

export async function makeDataDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "rivet data ")));
}

// A one-session run as the store keeps it, for tests that seed state directly.
export function sessionRun(data: string, o: { id?: string; project?: string; role?: "worker" | "orchestrator"; agent?: "claude" | "codex" | "fake"; task?: string } = {}): Run {
  const id = o.id ?? "r1";
  const project = o.project ?? "proj";
  return {
    id, project, repo: join(data, "..", "repo"), base: "main", task: o.task ?? "add login",
    createdAt: "2026-09-30T10:00:00.000Z", role: o.role ?? "worker", name: "",
    node: {
      id: NODE_ID, title: "add login", prompt: o.task ?? "add login", agent: o.agent ?? "claude",
      branch: branchName(id, NODE_ID), worktree: worktreePath(data, project, id, NODE_ID), status: "pending", attempts: 0,
    },
  };
}
