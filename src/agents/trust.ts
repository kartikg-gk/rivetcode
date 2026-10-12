import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export function claudeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

// One change at a time: two launches reading the same snapshot would drop an entry.
let chain: Promise<unknown> = Promise.resolve();

// Interactive Claude asks "do you trust this folder?" in every new directory, and a
// worktree is always new. Rivet's worktrees come from a repo the user already works
// in, so they are marked trusted before launch: only that one flag is added, the
// rest of the user's config is left exactly as it was. Returns whether it wrote.
export function ensureClaudeTrust(configPath: string, workspace: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const next = chain.then(() => trust(configPath, workspace, platform));
  chain = next.catch(() => {});
  return next;
}

async function trust(configPath: string, workspace: string, platform: NodeJS.Platform): Promise<boolean> {
  const key = platform === "win32" ? workspace.replace(/\\/g, "/") : workspace;
  let config: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = await readFile(configPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`read ${configPath}: ${(e as Error).message}`);
  }
  if (text !== null) {
    // Possibly another writer mid-way; never replace the user's whole config.
    if (text.trim() === "") throw new Error(`${configPath} is empty; refusing to overwrite it`);
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      config = parsed as Record<string, unknown>;
    } catch (e) {
      throw new Error(`parse ${configPath}: ${(e as Error).message}`);
    }
  }
  const projects = (config.projects && typeof config.projects === "object" ? config.projects : {}) as Record<string, Record<string, unknown>>;
  const entry = projects[key] && typeof projects[key] === "object" ? projects[key]! : {};
  if (entry.hasTrustDialogAccepted === true) return false;
  config.projects = { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } };

  await mkdir(dirname(configPath), { recursive: true });
  const tmp = join(dirname(configPath), `.${basename(configPath)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(config, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, configPath);
  } finally {
    await rm(tmp, { force: true });
  }
  return true;
}
