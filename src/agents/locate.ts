import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type LocateEnv = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
};

const current = (): LocateEnv => ({ platform: process.platform, env: process.env, home: homedir() });

function pathDirs(o: LocateEnv): string[] {
  const key = Object.keys(o.env).find((k) => k.toUpperCase() === "PATH");
  const raw = key ? o.env[key] ?? "" : "";
  return raw.split(o.platform === "win32" ? ";" : ":").filter(Boolean);
}

// Where claude can be, most specific first: the PATH, then the native installer's
// and npm's usual folders.
export function claudeCandidates(o: LocateEnv = current()): string[] {
  const win = o.platform === "win32";
  const names = win ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const fromPath = pathDirs(o).flatMap((d) => names.map((n) => join(d, n)));
  if (win) {
    const appData = o.env.APPDATA ?? join(o.home, "AppData", "Roaming");
    return [
      ...fromPath,
      join(o.home, ".local", "bin", "claude.exe"),
      join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
      join(appData, "npm", "claude.exe"),
      join(appData, "npm", "claude.cmd"),
    ];
  }
  return [
    ...fromPath,
    join(o.home, ".local", "bin", "claude"),
    join(o.home, ".claude", "local", "claude"),
    join(o.home, ".npm-global", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

// Child processes cannot run an npm .cmd shim directly; use the executable it wraps.
function unwrapShim(path: string): string {
  if (basename(path).toLowerCase() !== "claude.cmd") return path;
  const dir = dirname(path);
  for (const real of [
    join(dir, "claude.exe"),
    join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
  ]) {
    if (isFile(real)) return real;
  }
  return path;
}

export function findClaude(o: LocateEnv = current()): string {
  const explicit = o.env.RIVET_CLAUDE_BIN?.trim();
  if (explicit) {
    if (!isFile(explicit)) throw new Error(`RIVET_CLAUDE_BIN points at nothing: ${explicit}`);
    return explicit;
  }
  const found = claudeCandidates(o).find(isFile);
  if (!found) throw new Error("claude was not found on PATH or in its usual install folders (set RIVET_CLAUDE_BIN)");
  return unwrapShim(found);
}

// Codex: install folders first, then the PATH (skipping Windows Store aliases).
export function codexCandidates(o: LocateEnv = current()): string[] {
  const win = o.platform === "win32";
  const fromPath = pathDirs(o)
    .filter((d) => !(win && /[\\/]WindowsApps$/i.test(d)))
    .flatMap((d) => (win ? ["codex.cmd", "codex", "codex.exe"] : ["codex"]).map((n) => join(d, n)));
  if (win) {
    const appData = o.env.APPDATA ?? join(o.home, "AppData", "Roaming");
    const npmDir = join(appData, "npm");
    return [
      join(npmDir, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.exe"),
      join(npmDir, "codex.exe"),
      join(npmDir, "codex.cmd"),
      join(o.home, ".cargo", "bin", "codex.exe"),
      ...fromPath,
    ];
  }
  return [join(o.home, ".cargo", "bin", "codex"), join(o.home, ".local", "bin", "codex"), "/usr/local/bin/codex", "/opt/homebrew/bin/codex", ...fromPath];
}

export function findCodex(o: LocateEnv = current()): string {
  const explicit = o.env.RIVET_CODEX_BIN?.trim();
  if (explicit) {
    if (!isFile(explicit)) throw new Error(`RIVET_CODEX_BIN points at nothing: ${explicit}`);
    return explicit;
  }
  const found = codexCandidates(o).find(isFile);
  if (!found) throw new Error("codex was not found on PATH or in its usual install folders (set RIVET_CODEX_BIN)");
  if (basename(found).toLowerCase() !== "codex.cmd") return found;
  const dir = dirname(found);
  const real = [join(dir, "codex.exe"), join(dir, "node_modules", "@openai", "codex", "bin", "codex.exe")].find(isFile);
  return real ?? found;
}

// Delta: the PATH, then the folders pipx and uv install tools into. Rivet talks to delta
// over its rpc mode, which older deltas lack, so the first one that has it is used.
export function deltaCandidates(o: LocateEnv = current()): string[] {
  const win = o.platform === "win32";
  const names = win ? ["delta.exe", "delta"] : ["delta"];
  const fromPath = pathDirs(o).flatMap((d) => names.map((n) => join(d, n)));
  return [...fromPath, ...names.map((n) => join(o.home, ".local", "bin", n))];
}

// Whether a delta has the rpc mode Rivet needs; its help lists the option.
export function speaksRpc(binary: string): boolean {
  const r = spawnSync(binary, ["--help"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  return /--mode\b/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

const checked = new Map<string, string>();
// The delta to run when none is configured: the usable one found, else plain "delta" (whose
// failure then says why).
export function defaultDelta(): string {
  try { return findDelta(); } catch { return "delta"; }
}

export function findDelta(o: LocateEnv = current(), probe: (binary: string) => boolean = speaksRpc): string {
  const explicit = o.env.RIVET_DELTA_BIN?.trim();
  if (explicit) {
    if (!isFile(explicit)) throw new Error(`RIVET_DELTA_BIN points at nothing: ${explicit}`);
    return explicit;
  }
  const found = [...new Set(deltaCandidates(o))].filter(isFile);
  if (!found.length) throw new Error("delta was not found on PATH or in ~/.local/bin (set delta.binary or RIVET_DELTA_BIN)");
  const key = found.join("|");
  const known = checked.get(key);
  if (known) return known;
  const usable = found.find(probe);
  if (!usable) throw new Error(`${found[0]} is a delta without --mode rpc, too old for Rivet; install a newer delta or set delta.binary`);
  checked.set(key, usable);
  return usable;
}
