import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class WorkspaceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const locks = new Map<string, Promise<unknown>>();
const MAX_TEXT_BYTES = 512 * 1024;
const versionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function lockWorkspace<T>(root: string, work: () => Promise<T>): Promise<T> {
  const canonical = await realpath(root);
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const pending = (locks.get(key) ?? Promise.resolve()).then(work, work);
  const tail = pending.catch(() => {});
  locks.set(key, tail);
  try { return await pending; }
  finally { if (locks.get(key) === tail) locks.delete(key); }
}

async function target(root: string, path: string, creating = false): Promise<string> {
  const parts = path.replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
  if (path.length > 2000 || isAbsolute(path) || /^[a-z]:/i.test(path) || parts.some(part => part === ".." || part.toLowerCase() === ".git" || part.includes("\0") || part.includes(":") || /[. ]$/.test(part))) throw new WorkspaceError(400, "choose a path inside this workspace");
  if ((await lstat(root)).isSymbolicLink()) throw new WorkspaceError(409, "workspace root is a symbolic link");
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, ...parts);
  const parent = creating ? await realpath(dirname(candidate)) : await realpath(candidate);
  const inside = relative(canonicalRoot, parent);
  if (inside.split(sep).some(part => part.toLowerCase() === ".git")) throw new WorkspaceError(403, "Git metadata is not editable");
  if (inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) throw new WorkspaceError(403, "path leaves the workspace");
  if (!creating && (await lstat(candidate)).isSymbolicLink()) throw new WorkspaceError(403, "open the original file instead of a symbolic link");
  return candidate;
}

export async function listFiles(root: string, path: string, after = "") {
  const directory = await target(root, path);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.name.toLowerCase() !== ".git" && entry.name > after)
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    entries: entries.slice(0, 250).map(entry => ({ name: entry.name, kind: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : "file" })),
    next: entries.length > 250 ? entries[249]!.name : null,
  };
}

export async function readTextFile(root: string, path: string) {
  const file = await target(root, path);
  const before = await lstat(file);
  if (!before.isFile() || before.size > MAX_TEXT_BYTES) throw new WorkspaceError(413, "text editor supports files up to 512 KiB");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new WorkspaceError(409, "file changed while opening");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) throw new WorkspaceError(415, "this file is not editable UTF-8 text");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new WorkspaceError(415, "this file is not editable UTF-8 text"); }
    return { text, version: versionOf(bytes) };
  } finally { await handle.close(); }
}

export async function saveTextFile(root: string, path: string, text: string, expected: string | null) {
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new WorkspaceError(413, "text editor supports files up to 512 KiB");
  return lockWorkspace(root, async () => {
    const file = await target(root, path, true);
    let current: Buffer | undefined;
    let mode = 0o600;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new WorkspaceError(403, "choose a regular file");
      current = await readFile(file);
      mode = info.mode & 0o777;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if ((current ? versionOf(current) : null) !== expected) throw new WorkspaceError(409, "file changed; reload it before saving");
    const temporary = join(dirname(file), ".rivet-edit-" + randomUUID());
    try {
      await writeFile(temporary, text, { flag: "wx", mode });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    return { version: versionOf(Buffer.from(text)) };
  });
}
