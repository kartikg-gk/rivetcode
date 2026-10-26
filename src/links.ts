import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git } from "./git.js";

// Folders like node_modules or .venv can be linked from the main checkout into a worktree
// instead of copied: instant and no extra disk, but every worktree then shares (and can
// change) the same folder. Each worktree records its links in its own git folder, so its
// removal takes the links out first and never deletes what they point to.

export class LinkError extends Error {}

const RECORD = "rivet-links";

async function gitDir(worktree: string): Promise<string> {
  return (await git(["rev-parse", "--path-format=absolute", "--git-dir"], worktree)).trim();
}

async function commonDir(worktree: string): Promise<string> {
  return (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree)).trim();
}

function checkPath(entry: string): string {
  const rel = entry.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!rel || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.split("/").includes("..")) {
    throw new LinkError(`symlink entry must be a path inside the repo: "${entry}"`);
  }
  return rel;
}

export async function linkListed(repo: string, worktree: string, entries: string[], platform: string = process.platform): Promise<string[]> {
  const made: string[] = [];
  for (const entry of entries) {
    const rel = checkPath(entry);
    const from = join(repo, rel);
    if (!existsSync(from)) continue;
    // Something git tracks, linked, would let one worktree's changes reach all of them.
    try {
      await git(["check-ignore", "-q", "--no-index", rel], repo);
    } catch {
      throw new LinkError(`symlink only takes paths git ignores; "${rel}" is not ignored`);
    }
    const to = join(worktree, rel);
    if (existsSync(to)) continue;
    const isDir = (await stat(from)).isDirectory();
    await mkdir(dirname(to), { recursive: true });
    try {
      // A junction needs no special rights on Windows; a file link needs developer mode.
      await symlink(from, to, isDir ? (platform === "win32" ? "junction" : "dir") : "file");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") {
        throw new LinkError(`cannot link the file "${rel}" here (Windows needs developer mode for file links); list it under copy instead`);
      }
      throw e;
    }
    made.push(rel);
  }
  if (made.length === 0) return made;
  const dir = await gitDir(worktree);
  await writeFile(join(dir, RECORD), made.join("\n") + "\n");
  // Git sees a link as a file, which "node_modules/" (folders only) does not ignore; the
  // exact path is added to the repository's own exclude list so the worktree stays clean.
  const status = await git(["status", "--porcelain", "--", ...made], worktree);
  const shown = made.filter((rel) => status.split(/\r?\n/).some((l) => l.startsWith("?? ") && l.slice(3).replace(/\/$/, "") === rel));
  if (shown.length) {
    const exclude = join(await commonDir(worktree), "info", "exclude");
    await mkdir(dirname(exclude), { recursive: true });
    const have = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
    const add = shown.map((rel) => `/${rel}`).filter((line) => !have.split(/\r?\n/).includes(line));
    if (add.length) await appendFile(exclude, `${have && !have.endsWith("\n") ? "\n" : ""}# linked into worktrees by rivet\n${add.join("\n")}\n`);
  }
  return made;
}

// The links a worktree recorded, read before git forgets the worktree.
export async function recordedLinks(worktree: string): Promise<string[]> {
  try {
    const text = await readFile(join(await gitDir(worktree), RECORD), "utf8");
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Takes the links themselves out of a tree, never what they point to.
export async function unlinkAll(root: string, links: string[]): Promise<void> {
  for (const rel of links) {
    const at = join(root, rel);
    let info;
    try { info = await lstat(at); } catch { continue; }
    if (!info.isSymbolicLink()) continue;
    // A Windows junction comes out with rmdir, a symlink with unlink; neither follows it.
    await unlink(at).catch(() => rmdir(at));
  }
}
