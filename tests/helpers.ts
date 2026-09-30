import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.js";

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
  await rm(dir, { recursive: true, force: true });
}
