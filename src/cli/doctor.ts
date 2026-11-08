import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Level = "ok" | "warn" | "fail";
export type Check = { level: Level; name: string; message: string };

// Everything doctor looks at, swappable so tests do not depend on this machine.
export type Probes = {
  nodeVersion: string;
  run(file: string, args: string[]): Promise<string>;
  findClaude(): string;
  findCodex(): string;
  loadPty(): boolean;
  daemonUp(): Promise<boolean>;
  githubToken(): Promise<string>;
  cliBuilt(): boolean;
  now(): number;
};

const run = (file: string, args: string[]) => new Promise<string>((resolve, reject) => {
  // A failure keeps what was printed: "not logged in" comes with a non-zero exit.
  execFile(file, args, { windowsHide: true, timeout: 10_000 }, (e, out, err) =>
    // Some CLIs print their answer on stderr (codex login status does).
    (e ? reject(Object.assign(e, { stdout: String(out), stderr: String(err) })) : resolve((String(out).trim() || String(err)).trim())));
});

export const realProbes = (overrides: Partial<Probes>): Probes => ({
  nodeVersion: process.versions.node,
  run,
  findClaude: () => { throw new Error("not checked"); },
  findCodex: () => { throw new Error("not checked"); },
  loadPty: () => false,
  daemonUp: async () => false,
  githubToken: async () => { throw new Error("not checked"); },
  cliBuilt: () => existsSync(fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url))),
  now: () => Date.now(),
  ...overrides,
});

function versionAtLeast(found: string, want: [number, number]): boolean {
  const [major = 0, minor = 0] = found.split(".").map((n) => parseInt(n, 10));
  return major > want[0] || (major === want[0] && minor >= want[1]);
}

async function agentCheck(name: string, find: () => string, p: Probes): Promise<Check> {
  let binary: string;
  try { binary = find(); } catch (e) { return { level: "warn", name, message: `${(e as Error).message}; runs that use ${name} will be refused` }; }
  const version = await p.run(binary, ["--version"]).catch(() => "");
  if (!version) return { level: "warn", name, message: `${binary} does not answer --version` };
  const found = `${version.split(/\r?\n/)[0]} (${binary})`;
  const login = await loginStatus(name, binary, p);
  if (login === false) return { level: "warn", name, message: `${found}; not logged in, so its runs will fail: run rivet login ${name}` };
  return { level: "ok", name, message: login ? `${found}; logged in ${login}` : found };
}

// Who an agent's own CLI is logged in as: a description, false when it is not logged in,
// or null when the CLI cannot tell (an older version).
async function loginStatus(name: string, binary: string, p: Probes): Promise<string | false | null> {
  if (name === "claude") {
    const out = await p.run(binary, ["auth", "status"]).catch((e: { stdout?: string }) => e.stdout ?? "");
    try {
      const s = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string; email?: string };
      if (typeof s.loggedIn !== "boolean") return null;
      if (!s.loggedIn) return false;
      return [s.authMethod && `with ${s.authMethod}`, s.email && `as ${s.email}`].filter(Boolean).join(" ");
    } catch { return null; }
  }
  if (name === "codex") {
    const out = await p.run(binary, ["login", "status"]).catch((e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ""}${e.stderr ?? ""}`);
    if (/not logged in/i.test(out)) return false;
    const how = /logged in using (.+)/i.exec(out)?.[1]?.trim();
    return how ? `with ${how}` : null;
  }
  return null;
}

// One line per thing Rivet needs: what works, what is degraded, what blocks it.
export async function doctor(dataDir: string, p: Probes): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(versionAtLeast(p.nodeVersion, [24, 0])
    ? { level: "ok", name: "node", message: p.nodeVersion }
    : { level: "fail", name: "node", message: `${p.nodeVersion}; Rivet needs Node 24 or newer` });

  const git = await p.run("git", ["--version"]).catch(() => "");
  const gitVersion = /(\d+\.\d+(\.\d+)?)/.exec(git)?.[1];
  if (!gitVersion) checks.push({ level: "fail", name: "git", message: "git was not found on PATH" });
  else if (!versionAtLeast(gitVersion, [2, 38])) checks.push({ level: "warn", name: "git", message: `${gitVersion}; the conflict radar needs 2.38 or newer` });
  else checks.push({ level: "ok", name: "git", message: gitVersion });

  try {
    mkdirSync(dataDir, { recursive: true });
    const probe = join(dataDir, `.doctor-${process.pid}`);
    writeFileSync(probe, "x");
    rmSync(probe);
    checks.push({ level: "ok", name: "data dir", message: dataDir });
  } catch (e) {
    checks.push({ level: "fail", name: "data dir", message: `${dataDir} is not writable: ${(e as Error).message}` });
  }

  checks.push(p.cliBuilt()
    ? { level: "ok", name: "build", message: "dist/cli/main.js present" }
    : { level: "fail", name: "build", message: "dist/cli/main.js is missing; run npm run build (agent hooks call it)" });

  checks.push(await p.daemonUp()
    ? { level: "ok", name: "daemon", message: "running" }
    : { level: "warn", name: "daemon", message: "not running; commands you type start it" });

  checks.push(p.loadPty()
    ? { level: "ok", name: "terminals", message: "node-pty loads" }
    : { level: "warn", name: "terminals", message: "node-pty does not load; worker.view=interactive, attach and panes are unavailable" });

  checks.push(await agentCheck("claude", p.findClaude, p));
  checks.push(await agentCheck("codex", p.findCodex, p));

  try {
    await p.githubToken();
    checks.push({ level: "ok", name: "github", message: "a token is available" });
  } catch (e) {
    checks.push({ level: "warn", name: "github", message: `${(e as Error).message}; pull requests are unavailable` });
  }

  // Hooks never fail an agent, so their failures only show up here.
  const log = join(dataDir, "hooks.log");
  if (existsSync(log) && statSync(log).size > 0) {
    const day = p.now() - 24 * 3600_000;
    const recent = (await readFile(log, "utf8")).split(/\r?\n/).filter((l) => Date.parse(l.split(" ")[0] ?? "") > day);
    checks.push(recent.length
      ? { level: "warn", name: "hooks", message: `${recent.length} hook failures in the last day, e.g. ${recent.at(-1)!.slice(25, 160)} (${log})` }
      : { level: "ok", name: "hooks", message: "no recent failures" });
  } else {
    checks.push({ level: "ok", name: "hooks", message: "no failures logged" });
  }
  return checks;
}
