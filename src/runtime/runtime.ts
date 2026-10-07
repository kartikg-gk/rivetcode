import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, statSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { signalTree } from "../proc.js";

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export type StartOptions = {
  sessionId: string;
  workspace: string;
  argv: string[];
  // Added on top of the daemon's own environment.
  env: Record<string, string>;
  // Given when the caller already told the agent its launch id; otherwise one is made.
  launchId?: string;
  // "ignore" for agents that take no typed input (they see end-of-input at once).
  stdin?: "pipe" | "ignore";
};

export type Launch = { sessionId: string; launchId: string };
export type Output = { alive: boolean; exitCode: number | null; lines: string[] };
export type ExitListener = (sessionId: string, launchId: string, exitCode: number | null) => void;

export type Runtime = {
  start(o: StartOptions): Promise<Launch>;
  isAlive(sessionId: string): boolean;
  output(sessionId: string, lines: number): Output | null;
  write(sessionId: string, text: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  stopAll(): Promise<void>;
  forget(sessionId: string): void;
  liveSessions(): string[];
  onExit(listener: ExitListener): () => void;
};

// Windows treats env names case-insensitively, so an override replaces "Path" as well as "PATH".
function mergeEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (process.platform === "win32") {
      for (const existing of Object.keys(merged)) {
        if (existing.toUpperCase() === key.toUpperCase()) delete merged[existing];
      }
    }
    merged[key] = value;
  }
  return merged;
}

export function newLaunchId(): string {
  return randomBytes(8).toString("hex");
}

// One agent process and everything it printed.
type Proc = {
  launchId: string;
  child: ChildProcess;
  alive: boolean;
  exitCode: number | null;
  lines: string[];
  partial: string;
  log: WriteStream;
  closed: Promise<void>;
};

// Runs agent CLIs as plain child processes: no shell, one live process per session.
// Output stays readable after exit so a crash can be diagnosed.
export function createRuntime(o: { logDir: string; keepLines?: number; stopGraceMs?: number }): Runtime {
  const keep = o.keepLines ?? 2000;
  const grace = o.stopGraceMs ?? 5000;
  const procs = new Map<string, Proc>();
  const listeners = new Set<ExitListener>();
  // Sessions between "start called" and "process spawned": a second start must see them.
  const starting = new Set<string>();

  function record(p: Proc, chunk: Buffer): void {
    p.log.write(chunk);
    const parts = (p.partial + chunk.toString("utf8")).split(/\r?\n/);
    p.partial = parts.pop() ?? "";
    p.lines.push(...parts);
    if (p.lines.length > keep) p.lines.splice(0, p.lines.length - keep);
  }

  async function start(opts: StartOptions): Promise<Launch> {
    const { sessionId, workspace, argv } = opts;
    if (procs.get(sessionId)?.alive || starting.has(sessionId)) {
      throw new RuntimeError(`session ${sessionId} is already running`);
    }
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      throw new RuntimeError(`workspace does not exist: ${workspace}`);
    }
    if (argv.length === 0 || !argv[0]) throw new RuntimeError("empty command");
    starting.add(sessionId);
    try {
      return await spawnProcess(opts);
    } finally {
      starting.delete(sessionId);
    }
  }

  async function spawnProcess(opts: StartOptions): Promise<Launch> {
    const { sessionId, workspace, argv } = opts;

    const child = spawn(argv[0], argv.slice(1), {
      cwd: workspace,
      env: mergeEnv(process.env, opts.env),
      stdio: [opts.stdin ?? "pipe", "pipe", "pipe"],
      windowsHide: true,
      // Own process group on POSIX, so stop() reaches the tools the agent started too.
      detached: process.platform !== "win32",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (e) {
      throw new RuntimeError(`could not start ${argv[0]}: ${(e as Error).message}`);
    }

    mkdirSync(o.logDir, { recursive: true });
    const launchId = opts.launchId ?? newLaunchId();
    let markClosed!: () => void;
    const p: Proc = {
      launchId, child, alive: true, exitCode: null, lines: [], partial: "",
      log: createWriteStream(join(o.logDir, `${sessionId}.log`), { flags: "a" }),
      closed: new Promise((resolve) => { markClosed = resolve; }),
    };
    procs.set(sessionId, p);
    // A broken pipe on a dead agent's stdin must not crash the daemon.
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (c: Buffer) => record(p, c));
    child.stderr?.on("data", (c: Buffer) => record(p, c));
    child.once("close", (code) => {
      if (p.partial) p.lines.push(p.partial);
      p.partial = "";
      p.alive = false;
      p.exitCode = code;
      p.log.end(() => {
        markClosed();
        for (const listener of [...listeners]) listener(sessionId, launchId, code);
      });
    });
    return { sessionId, launchId };
  }

  async function stop(sessionId: string): Promise<void> {
    const p = procs.get(sessionId);
    if (!p) return;
    if (p.alive) {
      const pid = p.child.pid!;
      signalTree(pid, "SIGTERM");
      const timer = setTimeout(() => { if (p.alive) signalTree(pid, "SIGKILL"); }, grace);
      await p.closed;
      clearTimeout(timer);
    }
    await p.closed;
  }

  return {
    start,
    isAlive: (sessionId) => procs.get(sessionId)?.alive ?? false,
    output(sessionId, lines) {
      const p = procs.get(sessionId);
      if (!p) return null;
      const all = p.partial ? [...p.lines, p.partial] : p.lines;
      return { alive: p.alive, exitCode: p.exitCode, lines: all.slice(-Math.max(0, lines)) };
    },
    async write(sessionId, text) {
      const p = procs.get(sessionId);
      if (!p?.alive) throw new RuntimeError(`session ${sessionId} is not running`);
      if (!p.child.stdin) throw new RuntimeError(`session ${sessionId} does not take input`);
      await new Promise<void>((resolve, reject) => {
        p.child.stdin!.write(text + "\n", (e) => (e ? reject(new RuntimeError(`write to ${sessionId}: ${e.message}`)) : resolve()));
      });
    },
    stop,
    async stopAll() {
      await Promise.all([...procs.keys()].map(stop));
    },
    forget(sessionId) {
      if (!procs.get(sessionId)?.alive) procs.delete(sessionId);
    },
    liveSessions: () => [...procs].filter(([, p]) => p.alive).map(([id]) => id),
    onExit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
