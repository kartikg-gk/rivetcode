import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, statSync, type WriteStream } from "node:fs";
import { createRequire } from "node:module";
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
  // Run inside a pseudo-terminal, so an interactive app can draw and be typed into.
  terminal?: { cols: number; rows: number };
};

export type Launch = { sessionId: string; launchId: string };
export type Output = { alive: boolean; exitCode: number | null; lines: string[] };
export type ExitListener = (sessionId: string, launchId: string, exitCode: number | null) => void;

export type Runtime = {
  start(o: StartOptions): Promise<Launch>;
  isAlive(sessionId: string): boolean;
  // Whether a running session reads what is typed to it (a headless agent does not).
  takesInput(sessionId: string): boolean;
  output(sessionId: string, lines: number): Output | null;
  // Types a line (text, then Enter).
  write(sessionId: string, text: string): Promise<void>;
  // Raw keystrokes from someone attached to the terminal.
  input(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  // The recent raw output (to redraw an attached terminal), then every new chunk.
  attach(sessionId: string, onData: (chunk: string) => void): { replay: string; detach(): void } | null;
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

// What the runtime needs from a running process, whether piped or in a terminal.
type Handle = {
  pid: number;
  terminal: boolean;
  takesInput: boolean;
  send(data: string): Promise<void>;
  resize(cols: number, rows: number): void;
};

type PtyProcess = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(fn: (data: string) => void): void;
  onExit(fn: (e: { exitCode: number }) => void): void;
};
type PtyModule = { spawn(file: string, args: string[], o: Record<string, unknown>): PtyProcess };

let ptyModule: PtyModule | null | undefined;
// node-pty is a native module; without it Rivet still runs agents headless.
export function loadPty(): PtyModule | null {
  if (ptyModule === undefined) {
    try { ptyModule = createRequire(import.meta.url)("node-pty") as PtyModule; } catch { ptyModule = null; }
  }
  return ptyModule;
}

const REPLAY_LIMIT = 256 * 1024;

// One agent process and everything it printed.
type Proc = {
  launchId: string;
  handle: Handle;
  alive: boolean;
  exitCode: number | null;
  lines: string[];
  partial: string;
  raw: string;
  watchers: Set<(chunk: string) => void>;
  log: WriteStream;
  closed: Promise<void>;
};

// Runs agent CLIs as child processes (no shell), piped or in a pseudo-terminal, one
// live process per session. Output stays readable after exit so a crash can be diagnosed.
// Typing into a terminal: pieces of text, a gap between them, and a pause before Enter.
const TYPE_CHUNK = 512;
const TYPE_CHUNK_GAP_MS = 15;
const TYPE_SUBMIT_DELAY_MS = 300;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createRuntime(o: { logDir: string; keepLines?: number; stopGraceMs?: number }): Runtime {
  const keep = o.keepLines ?? 2000;
  const grace = o.stopGraceMs ?? 5000;
  const procs = new Map<string, Proc>();
  const listeners = new Set<ExitListener>();
  // Sessions between "start called" and "process spawned": a second start must see them.
  const starting = new Set<string>();

  function record(p: Proc, chunk: string): void {
    p.log.write(chunk);
    p.raw = (p.raw + chunk).slice(-REPLAY_LIMIT);
    for (const watch of p.watchers) watch(chunk);
    const parts = (p.partial + chunk).split(/\r?\n/);
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
    if (opts.terminal && !loadPty()) throw new RuntimeError("terminal sessions need node-pty, which could not be loaded");
    starting.add(sessionId);
    try {
      return await launch(opts);
    } finally {
      starting.delete(sessionId);
    }
  }

  async function launch(opts: StartOptions): Promise<Launch> {
    const { sessionId } = opts;
    mkdirSync(o.logDir, { recursive: true });
    const launchId = opts.launchId ?? newLaunchId();
    let markClosed!: () => void;
    const p = {
      launchId, alive: true, exitCode: null, lines: [], partial: "", raw: "", watchers: new Set(),
      log: createWriteStream(join(o.logDir, `${sessionId}.log`), { flags: "a" }),
      closed: new Promise<void>((resolve) => { markClosed = resolve; }),
    } as unknown as Proc;
    const exited = (code: number | null) => {
      if (!p.alive) return;
      if (p.partial) p.lines.push(p.partial);
      p.partial = "";
      p.alive = false;
      p.exitCode = code;
      p.log.end(() => {
        markClosed();
        for (const listener of [...listeners]) listener(sessionId, launchId, code);
      });
    };
    try {
      p.handle = opts.terminal ? spawnTerminal(opts, p, exited) : await spawnPiped(opts, p, exited);
    } catch (e) {
      p.log.end();
      throw e instanceof RuntimeError ? e : new RuntimeError(`could not start ${opts.argv[0]}: ${(e as Error).message}`);
    }
    procs.set(sessionId, p);
    return { sessionId, launchId };
  }

  async function spawnPiped(opts: StartOptions, p: Proc, exited: (code: number | null) => void): Promise<Handle> {
    const child = spawn(opts.argv[0]!, opts.argv.slice(1), {
      cwd: opts.workspace,
      env: mergeEnv(process.env, opts.env),
      stdio: [opts.stdin ?? "pipe", "pipe", "pipe"],
      windowsHide: true,
      // Own process group on POSIX, so stop() reaches the tools the agent started too.
      detached: process.platform !== "win32",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    // A broken pipe on a dead agent's stdin must not crash the daemon.
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (c: Buffer) => record(p, c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => record(p, c.toString("utf8")));
    child.once("close", (code) => exited(code));
    return {
      pid: child.pid!,
      terminal: false,
      takesInput: !!child.stdin,
      send: (data) => new Promise((resolve, reject) => {
        child.stdin!.write(data, (e) => (e ? reject(e) : resolve()));
      }),
      resize: () => {},
    };
  }

  function spawnTerminal(opts: StartOptions, p: Proc, exited: (code: number | null) => void): Handle {
    const term = loadPty()!.spawn(opts.argv[0]!, opts.argv.slice(1), {
      name: "xterm-256color",
      cols: opts.terminal!.cols,
      rows: opts.terminal!.rows,
      cwd: opts.workspace,
      env: mergeEnv(process.env, opts.env),
    });
    term.onData((data) => { if (p.alive) record(p, data); });
    term.onExit(({ exitCode }) => exited(exitCode));
    return {
      pid: term.pid,
      terminal: true,
      takesInput: true,
      send: async (data) => { term.write(data); },
      resize: (cols, rows) => term.resize(cols, rows),
    };
  }

  async function stop(sessionId: string): Promise<void> {
    const p = procs.get(sessionId);
    if (!p) return;
    if (p.alive) {
      const pid = p.handle.pid;
      signalTree(pid, "SIGTERM");
      const timer = setTimeout(() => { if (p.alive) signalTree(pid, "SIGKILL"); }, grace);
      await p.closed;
      clearTimeout(timer);
    }
    await p.closed;
  }

  function live(sessionId: string): Proc {
    const p = procs.get(sessionId);
    if (!p?.alive) throw new RuntimeError(`session ${sessionId} is not running`);
    return p;
  }

  return {
    start,
    isAlive: (sessionId) => procs.get(sessionId)?.alive ?? false,
    takesInput: (sessionId) => { const p = procs.get(sessionId); return !!p?.alive && p.handle.takesInput; },
    output(sessionId, lines) {
      const p = procs.get(sessionId);
      if (!p) return null;
      const all = p.partial ? [...p.lines, p.partial] : p.lines;
      return { alive: p.alive, exitCode: p.exitCode, lines: all.slice(-Math.max(0, lines)) };
    },
    async write(sessionId, text) {
      const p = live(sessionId);
      if (!p.handle.takesInput) throw new RuntimeError(`session ${sessionId} does not take input`);
      try {
        if (!p.handle.terminal) {
          // A piped agent reads lines.
          await p.handle.send(text + "\n");
          return;
        }
        // A terminal app takes fast input as a paste, and an Enter inside a paste does not
        // submit it. So the text goes in pieces, settles, and Enter comes on its own.
        const chars = [...text];
        for (let i = 0; i < chars.length; i += TYPE_CHUNK) {
          await p.handle.send(chars.slice(i, i + TYPE_CHUNK).join(""));
          if (i + TYPE_CHUNK < chars.length) await pause(TYPE_CHUNK_GAP_MS);
        }
        if (chars.length > 0) await pause(TYPE_SUBMIT_DELAY_MS);
        await p.handle.send("\r");
      } catch (e) { throw new RuntimeError(`write to ${sessionId}: ${(e as Error).message}`); }
    },
    input(sessionId, data) {
      const p = live(sessionId);
      if (!p.handle.terminal) throw new RuntimeError(`session ${sessionId} has no terminal`);
      void p.handle.send(data);
    },
    resize(sessionId, cols, rows) {
      live(sessionId).handle.resize(cols, rows);
    },
    attach(sessionId, onData) {
      const p = procs.get(sessionId);
      if (!p) return null;
      p.watchers.add(onData);
      return { replay: p.raw, detach: () => { p.watchers.delete(onData); } };
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
