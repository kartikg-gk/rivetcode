import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type HookSpec = { event: string; matcher?: string; command: string };

type Entry = { command?: unknown; [field: string]: unknown };
type Group = { matcher?: string | null; hooks: Entry[]; [field: string]: unknown };
type Settings = { hooks?: Record<string, unknown>; [field: string]: unknown };

export type HooksManager = {
  install(workspace: string): Promise<void>;
  uninstall(workspace: string): Promise<void>;
  installed(workspace: string): Promise<boolean>;
};

export const GITIGNORE_MARKER = "# managed by rivet: hook files stay out of git status";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// The settings file belongs to the user. Anything malformed is reported, never rewritten.
async function loadSettings(file: string): Promise<Settings | null> {
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw new Error(`read ${file}: ${e.message}`);
  });
  if (text === null) return null;
  if (text.trim() === "") return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`parse ${file}: ${(e as Error).message}`);
  }
  if (!isRecord(data)) throw new Error(`parse ${file}: expected a JSON object`);
  if (data.hooks === null) delete data.hooks;
  if (data.hooks !== undefined && !isRecord(data.hooks)) throw new Error(`parse hooks in ${file}: expected an object`);
  return data as Settings;
}

function groupsOf(hooks: Record<string, unknown>, event: string): Group[] {
  const value = hooks[event] ?? [];
  const malformed = new Error(`parse ${event} hooks: expected a list of {matcher, hooks: [...]}`);
  if (!Array.isArray(value)) throw malformed;
  return value.map((group: unknown) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) throw malformed;
    return { ...group, hooks: group.hooks.map((h: unknown) => (isRecord(h) ? { ...h } : {})) };
  });
}

// Temp file, flushed, then renamed over the target: a crash leaves the old file or the new one.
async function writeFileSafely(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o750 });
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function saveSettings(file: string, settings: Settings, hooks: Record<string, unknown>): Promise<void> {
  const out: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  await writeFileSafely(file, JSON.stringify(out, null, 2) + "\n");
}

// Keeps a hook file out of the user's git status. A .gitignore the user wrote is never touched.
export async function ensureWorkspaceGitignore(dir: string, ...names: string[]): Promise<void> {
  const path = join(dir, ".gitignore");
  const current = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw new Error(`read ${path}: ${e.message}`);
  });
  if (current !== null && !current.includes(GITIGNORE_MARKER)) return;
  const lines = [GITIGNORE_MARKER, "/.gitignore", ...names.map((n) => "/" + n.replace(/\\/g, "/"))];
  await writeFileSafely(path, lines.join("\n") + "\n");
}

// Rivet's hooks live in the agent's own settings file, next to the user's hooks.
// Ours are recognised by their command prefix; everything else is left as it was.
export function hooksManager(o: {
  label: string;
  prefix: string;
  timeout: number;
  path: (workspace: string) => string;
  managed: HookSpec[];
}): HooksManager {
  const events = [...new Set(o.managed.map((h) => h.event))];
  const ours = (entry: Entry) => typeof entry.command === "string" && entry.command.startsWith(o.prefix);

  async function guarded<T>(op: string, workspace: string, fn: (file: string) => Promise<T>): Promise<T> {
    if (workspace.trim() === "") throw new Error(`${o.label}.${op}: workspace is required`);
    try {
      return await fn(o.path(workspace));
    } catch (e) {
      throw new Error(`${o.label}.${op}: ${(e as Error).message}`);
    }
  }

  // Takes our entries out, then puts the current ones back. Fields someone added to one
  // of our entries survive; a group we emptied is reused so its own fields survive too.
  function placeOurs(groups: Group[], specs: HookSpec[]): Group[] {
    const extras = new Map<string, Entry>();
    const emptied = new Set<Group>();
    for (const group of groups) {
      for (const entry of group.hooks.filter(ours)) {
        if (!extras.has(entry.command as string)) extras.set(entry.command as string, entry);
      }
      const kept = group.hooks.filter((h) => !ours(h));
      if (kept.length === 0 && group.hooks.length > 0) emptied.add(group);
      group.hooks = kept;
    }
    for (const spec of specs) {
      const entry: Entry = { ...extras.get(spec.command), type: "command", command: spec.command };
      if (o.timeout) entry.timeout = o.timeout;
      else delete entry.timeout;
      let home = groups.find((g) => (g.matcher ?? undefined) === spec.matcher && (g.hooks.length > 0 || emptied.has(g)));
      if (!home) {
        home = spec.matcher === undefined ? { hooks: [] } : { matcher: spec.matcher, hooks: [] };
        groups.push(home);
      }
      if (home.matcher === null) delete home.matcher;
      home.hooks.push(entry);
    }
    return groups.filter((g) => g.hooks.length > 0);
  }

  return {
    install: (workspace) =>
      guarded("install", workspace, async (file) => {
        const settings = (await loadSettings(file)) ?? {};
        const hooks = { ...settings.hooks };
        for (const event of events) {
          hooks[event] = placeOurs(groupsOf(hooks, event), o.managed.filter((h) => h.event === event));
        }
        await saveSettings(file, settings, hooks);
        await ensureWorkspaceGitignore(dirname(file), basename(file)).catch((e: Error) => {
          throw new Error(`gitignore: ${e.message}`);
        });
      }),

    uninstall: (workspace) =>
      guarded("uninstall", workspace, async (file) => {
        const settings = await loadSettings(file);
        if (settings === null) return;
        const hooks = { ...settings.hooks };
        for (const event of events) {
          const left = placeOurs(groupsOf(hooks, event), []);
          if (left.length > 0) hooks[event] = left;
          else delete hooks[event];
        }
        await saveSettings(file, settings, hooks);
      }),

    installed: (workspace) =>
      guarded("installed", workspace, async (file) => {
        const hooks = (await loadSettings(file))?.hooks ?? {};
        return events.some((event) => groupsOf(hooks, event).some((g) => g.hooks.some(ours)));
      }),
  };
}
