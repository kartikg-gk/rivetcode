import { parse as parseYaml } from "yaml";

// What a task file can ask of one worker beyond its task: its own definition of done,
// limits that stop it, and guardrails on what it may change and run.
export type TaskSpec = {
  // Always in the agent's own terminal, whatever the project's session mode.
  terminal?: boolean;
  // As a chat, whatever the project's session mode.
  chat?: boolean;
  // Replaces the project's check for this task; the project's tests still run.
  doneWhen?: string;
  // Stop and escalate once the worker has worked this long (from its first start)...
  minutes?: number;
  // ...or used this many input-equivalent tokens (price-weighted, as rivet status shows).
  tokens?: number;
  // Launches before Rivet stops retrying (default 2).
  attempts?: number;
  // Files the work may change, as globs ("src/export/**"); anything else sends it back.
  paths?: string[];
  // Tools the agent may not use, in its own rule form ("Bash(npm publish:*)").
  denyTools?: string[];
};

export type FileTask = { name: string; goal: string; agent?: string; model?: string; base?: string; spec: TaskSpec };

export class TaskFileError extends Error {}

const positive = (v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new TaskFileError(`${what} must be a positive number`);
  return v;
};
const text = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new TaskFileError(`${what} must be text`);
  return v.trim();
};
const texts = (v: unknown, what: string): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !s.trim())) throw new TaskFileError(`${what} must be a list of text`);
  return v.map((s: string) => s.trim());
};

// A spec as sent to the daemon (or read from a file), checked field by field.
export function checkSpec(raw: unknown, where = "spec"): TaskSpec {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new TaskFileError(`${where} must be a mapping`);
  const r = raw as Record<string, unknown>;
  const attempts = positive(r.attempts, `${where}.attempts`);
  if (attempts !== undefined && !Number.isInteger(attempts)) throw new TaskFileError(`${where}.attempts must be a whole number`);
  const spec: TaskSpec = {
    ...(text(r.doneWhen, `${where}.done_when`) ? { doneWhen: text(r.doneWhen, `${where}.done_when`)! } : {}),
    ...(positive(r.minutes, `${where}.limits.minutes`) ? { minutes: positive(r.minutes, `${where}.limits.minutes`)! } : {}),
    ...(positive(r.tokens, `${where}.limits.tokens`) ? { tokens: positive(r.tokens, `${where}.limits.tokens`)! } : {}),
    ...(attempts ? { attempts } : {}),
    ...(texts(r.paths, `${where}.guardrails.paths`) ? { paths: texts(r.paths, `${where}.guardrails.paths`)! } : {}),
    ...(texts(r.denyTools, `${where}.guardrails.deny_tools`) ? { denyTools: texts(r.denyTools, `${where}.guardrails.deny_tools`)! } : {}),
  };
  return spec;
}

const KNOWN = new Set(["name", "goal", "done_when", "agent", "model", "base", "limits", "guardrails"]);

// A task file: a list of tasks, or { defaults, tasks }. Defaults fill what a task leaves out.
export function parseTaskFile(source: string, fileName: string): FileTask[] {
  let doc: unknown;
  try {
    doc = fileName.toLowerCase().endsWith(".json") ? JSON.parse(source) : parseYaml(source);
  } catch (e) {
    throw new TaskFileError(`${fileName} cannot be read: ${(e as Error).message}`);
  }
  const top = Array.isArray(doc) ? { tasks: doc } : (doc ?? {}) as { defaults?: unknown; tasks?: unknown };
  if (!Array.isArray(top.tasks) || top.tasks.length === 0) throw new TaskFileError(`${fileName} has no tasks: give a list, or tasks: [...]`);
  const defaults = (top.defaults ?? {}) as Record<string, unknown>;
  return top.tasks.map((raw, i) => {
    const where = `task ${i + 1}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TaskFileError(`${where} must be a mapping`);
    const t = { ...defaults, ...(raw as Record<string, unknown>) } as Record<string, unknown>;
    for (const key of Object.keys(raw as object)) if (!KNOWN.has(key)) throw new TaskFileError(`${where}: unknown field "${key}"`);
    const goal = text(t.goal, `${where}.goal`);
    if (!goal) throw new TaskFileError(`${where} needs a goal`);
    const name = text(t.name, `${where}.name`) ?? goal.split(/\r?\n/)[0]!.slice(0, 100);
    const limits = { ...((defaults.limits ?? {}) as object), ...((t.limits ?? {}) as object) } as Record<string, unknown>;
    const guard = { ...((defaults.guardrails ?? {}) as object), ...((t.guardrails ?? {}) as object) } as Record<string, unknown>;
    const spec = checkSpec({
      doneWhen: t.done_when, minutes: limits.minutes, tokens: limits.tokens, attempts: limits.attempts,
      paths: guard.paths, denyTools: guard.deny_tools,
    }, where);
    const agent = text(t.agent, `${where}.agent`);
    const model = text(t.model, `${where}.model`);
    const base = text(t.base, `${where}.base`);
    return { name, goal, spec, ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(base ? { base } : {}) };
  });
}

// "**" any depth, "*" within one folder, "?" one character; paths use "/".
export function globMatch(pattern: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path.replace(/\\/g, "/"));
}

// Changed files that no allowed glob covers.
export function outsidePaths(files: string[], allowed: string[]): string[] {
  return files.filter((f) => !allowed.some((g) => globMatch(g, f)));
}
