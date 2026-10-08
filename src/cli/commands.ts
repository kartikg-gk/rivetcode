import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git } from "../git.js";
import { defaultProjectId } from "../paths.js";
import type { Run } from "../store.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readRunFile } from "../runfile.js";
import { agentSessionIdOf, deriveActivity } from "./activity.js";
import { callDaemon, dataDirFrom, DaemonDownError, DaemonError, runFileFrom } from "./client.js";

export type CliIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  readStdin(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
};

const USAGE = `usage: rivet <command>
  run --plan <file> [--repo <dir>] [--base <branch>] [--agent <name>] <task>
                                        start a run from a plan (JSON task tree)
  status [<run>]                        list runs, or show one run's tree
  resume <run>                          retry what was escalated or interrupted
  clean <run>                           remove a run's worktrees (branches stay)
  project get|set <key> <value>|unset <key>
                                        settings for this repo: check, test, worker.agent
  bench <spec.json>                     compare ways of splitting one task (e.g. single, flat, tree)
  daemon start|stop|status              run or control the background daemon
  hooks <agent> <event>                 receive an agent hook (called by the agent)
  report --done|--stuck|--needs-input --note <text>
                                        report this session's state (inside an agent)
  send --session <id> --message <text>  send a message to a running session`;

class UsageError extends Error {}

const HOOK_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 120_000;
const HOOK_LOG_LIMIT = 1024 * 1024;
const NOTE_LIMIT = 1000;

// --flag value / --flag; anything else is positional.
function parseFlags(args: string[], valued: string[]): { flags: Map<string, string | true>; rest: string[] } {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const name = a.slice(2);
    if (valued.includes(name)) {
      const value = args[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    } else {
      flags.set(name, true);
    }
  }
  return { flags, rest };
}

function requireSession(io: CliIo): string {
  const id = io.env.RIVET_SESSION_ID?.trim();
  if (!id) throw new UsageError("RIVET_SESSION_ID is required (run this inside an agent session)");
  return id;
}

// A failed hook must never break the agent: record why, keep the log small, exit 0.
async function logHookFailure(io: CliIo, line: string): Promise<void> {
  try {
    const dir = dataDirFrom(io.env);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "hooks.log");
    const size = await stat(file).then((s) => s.size, () => 0);
    if (size > HOOK_LOG_LIMIT) await writeFile(file, "");
    await appendFile(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Nowhere left to report to.
  }
}

async function hooks(args: string[], io: CliIo): Promise<number> {
  const [agent, event] = args;
  if (!agent || !event) throw new UsageError("hooks needs <agent> <event>");
  const sessionId = io.env.RIVET_SESSION_ID?.trim();
  // Not started by Rivet (e.g. the user's own session in the same folder): ignore quietly.
  if (!sessionId) return 0;
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await io.readStdin());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    // An unreadable payload still tells us which event fired.
  }
  const state = deriveActivity(agent, event, payload);
  const agentSessionId = agentSessionIdOf(payload);
  if (state === null && agentSessionId === undefined) return 0;
  const launchId = io.env.RIVET_LAUNCH_ID?.trim();
  try {
    await callDaemon(io.env, "POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/activity`, {
      ...(state ? { state } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
      ...(launchId ? { launchId } : {}),
    }, HOOK_TIMEOUT_MS);
  } catch (e) {
    await logHookFailure(io, `${agent} ${event} ${sessionId} ${(e as Error).message}`);
  }
  return 0;
}

async function report(args: string[], io: CliIo): Promise<number> {
  const { flags, rest } = parseFlags(args, ["note"]);
  if (rest.length > 0) throw new UsageError("report takes a state flag and --note, not free text");
  const kinds = (["done", "stuck", "needs-input"] as const).filter((k) => flags.has(k));
  if (kinds.length !== 1) throw new UsageError("report needs exactly one of --done, --stuck, --needs-input");
  const note = flags.get("note");
  if (typeof note !== "string" || note.trim() === "") throw new UsageError("report needs --note <text>");
  if (note.length > NOTE_LIMIT) throw new UsageError(`--note must be at most ${NOTE_LIMIT} characters`);
  const sessionId = requireSession(io);
  const result = await callDaemon(io.env, "POST", "/api/v1/reports", { sessionId, kind: kinds[0], message: note }, COMMAND_TIMEOUT_MS);
  io.out(`reported ${kinds[0]} (#${(result as { id: number }).id})`);
  return 0;
}

async function send(args: string[], io: CliIo): Promise<number> {
  const { flags } = parseFlags(args, ["session", "message"]);
  const session = flags.get("session");
  const message = flags.get("message");
  if (typeof session !== "string" || !session) throw new UsageError("send needs --session <id>");
  if (typeof message !== "string" || !message) throw new UsageError("send needs --message <text>");
  const from = io.env.RIVET_SESSION_ID?.trim();
  await callDaemon(io.env, "POST", `/api/v1/sessions/${encodeURIComponent(session)}/send`,
    { message, ...(from ? { from } : {}) }, COMMAND_TIMEOUT_MS);
  io.out(`sent to ${session}`);
  return 0;
}

async function daemon(args: string[], io: CliIo): Promise<number> {
  const runFile = runFileFrom(io.env);
  switch (args[0]) {
    case "start": {
      // Loaded only here: hooks run often and should not pay for the daemon's code.
      const { startDaemon } = await import("../daemon/server.js");
      const d = await startDaemon({
        data: dataDirFrom(io.env),
        runFile,
        ...(io.env.RIVET_PORT !== undefined ? { port: Number(io.env.RIVET_PORT) } : {}),
      });
      io.out(`rivet daemon listening on 127.0.0.1:${d.port} (pid ${process.pid})`);
      await d.stopped;
      return 0;
    }
    case "status": {
      const info = await readRunFile(runFile);
      try {
        await callDaemon(io.env, "GET", "/healthz", undefined, HOOK_TIMEOUT_MS);
      } catch {
        io.out("not running");
        return 1;
      }
      io.out(`running (pid ${info!.pid}, port ${info!.port})`);
      return 0;
    }
    case "stop":
      await callDaemon(io.env, "POST", "/shutdown", undefined, HOOK_TIMEOUT_MS);
      io.out("stopping");
      return 0;
    default:
      throw new UsageError("daemon needs start, stop or status");
  }
}

async function run(args: string[], io: CliIo): Promise<number> {
  const { flags, rest } = parseFlags(args, ["plan", "repo", "base", "agent"]);
  const planFile = flags.get("plan");
  const task = rest.join(" ").trim();
  if (typeof planFile !== "string") throw new UsageError("run needs --plan <file>");
  if (!task) throw new UsageError("run needs a task description");
  let plan: unknown;
  try {
    plan = JSON.parse(await readFile(resolve(io.cwd, planFile), "utf8"));
  } catch (e) {
    throw new Error(`could not read plan ${planFile}: ${(e as Error).message}`);
  }
  const repo = resolve(io.cwd, typeof flags.get("repo") === "string" ? (flags.get("repo") as string) : ".");
  const base = flags.get("base");
  const agent = flags.get("agent");
  const result = await callDaemon(io.env, "POST", "/api/v1/runs", {
    repo, task, plan,
    ...(typeof base === "string" ? { base } : {}),
    ...(typeof agent === "string" ? { agent } : {}),
  }, COMMAND_TIMEOUT_MS) as { runId: string };
  io.out(`run ${result.runId} started; follow it with: rivet status ${result.runId}`);
  return 0;
}

function ago(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

// One line per node: what it is, where it stands, and how long its agent has been quiet.
function renderRun(run: Run, live: Record<string, boolean>, now: number): string[] {
  const lines = [`run ${run.id} (root: ${run.nodes[0]!.status}) ${run.task}`];
  for (const n of run.nodes) {
    const name = `${"  ".repeat(n.depth)}${n.id} ${n.title}`;
    const parts = [name.padEnd(34), n.status.padEnd(11)];
    if (n.kind === "leaf" && n.activity) {
      const quiet = n.activity !== "active" && n.activity !== "exited" ? ` for ${ago(n.activityAt, now)}` : "";
      parts.push(`${n.activity}${quiet}`.padEnd(20));
    } else {
      parts.push("".padEnd(20));
    }
    if (live[n.id]) parts.push("[agent running]");
    if (n.finishedAt && n.status === "running") parts.push("[finished, waiting to merge]");
    if (n.summary) parts.push(n.summary.split(/\r?\n/)[0]!.slice(0, 120));
    lines.push(parts.join(" ").trimEnd());
  }
  return lines;
}

async function status(args: string[], io: CliIo): Promise<number> {
  const [runId] = args;
  if (!runId) {
    const { runs } = await callDaemon(io.env, "GET", "/api/v1/runs", undefined, COMMAND_TIMEOUT_MS) as {
      runs: { id: string; status: string; task: string; project: string }[];
    };
    if (runs.length === 0) io.out("no runs yet");
    for (const r of runs) io.out(`${r.id}  ${r.status.padEnd(11)} ${r.task}  [${r.project}]`);
    return 0;
  }
  const result = await callDaemon(io.env, "GET", `/api/v1/runs/${encodeURIComponent(runId)}`, undefined, COMMAND_TIMEOUT_MS) as {
    run: Run; live: Record<string, boolean>; now: string;
  };
  for (const line of renderRun(result.run, result.live, Date.parse(result.now))) io.out(line);
  return 0;
}

async function runAction(action: "resume" | "clean", args: string[], io: CliIo): Promise<number> {
  const [runId] = args;
  if (!runId) throw new UsageError(`${action} needs a run id`);
  const result = await callDaemon(io.env, "POST", `/api/v1/runs/${encodeURIComponent(runId)}/${action}`, undefined, COMMAND_TIMEOUT_MS);
  if (action === "resume") {
    io.out(`run ${runId} resumed`);
  } else {
    const { removed, kept } = result as { removed: string[]; kept: string[] };
    io.out(`removed ${removed.length} worktrees` + (kept.length ? `; kept ${kept.join(", ")} (uncommitted work)` : ""));
  }
  return 0;
}

async function projectOf(io: CliIo): Promise<string> {
  try {
    return defaultProjectId((await git(["rev-parse", "--show-toplevel"], io.cwd)).trim());
  } catch {
    throw new Error("run this inside the project's git repository");
  }
}

async function project(args: string[], io: CliIo): Promise<number> {
  const [action, key, ...valueParts] = args;
  const path = `/api/v1/projects/${encodeURIComponent(await projectOf(io))}/config`;
  if (action === "get") {
    const config = await callDaemon(io.env, "GET", path, undefined, COMMAND_TIMEOUT_MS) as Record<string, string>;
    const keys = Object.keys(config);
    if (keys.length === 0) io.out("no settings");
    for (const k of keys) io.out(`${k} = ${config[k]}`);
    return 0;
  }
  if (action === "set" && key && valueParts.length > 0) {
    await callDaemon(io.env, "PUT", path, { key, value: valueParts.join(" ") }, COMMAND_TIMEOUT_MS);
    io.out(`${key} set`);
    return 0;
  }
  if (action === "unset" && key) {
    await callDaemon(io.env, "PUT", path, { key, value: null }, COMMAND_TIMEOUT_MS);
    io.out(`${key} removed`);
    return 0;
  }
  throw new UsageError("project needs get, set <key> <value> or unset <key>");
}

async function bench(args: string[], io: CliIo): Promise<number> {
  const [specFile] = args;
  if (!specFile) throw new UsageError("bench needs a spec file");
  const { runBench, formatResult } = await import("../bench/bench.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const full = resolve(io.cwd, specFile);
  const spec = JSON.parse(await readFile(full, "utf8"));
  spec.repo = resolve(dirname(full), spec.repo);
  const workDir = await mkdtemp(join(tmpdir(), "rivet bench "));
  io.out(`benchmark "${spec.name}" in ${workDir}`);
  const result = await runBench(spec, { workDir, log: io.out });
  const out = join(dirname(full), `${spec.name.replace(/[^\w.-]+/g, "-")}-results-${Date.now()}.json`);
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  for (const r of result.results) io.out(formatResult(r));
  io.out(result.verdict);
  io.out(`results: ${out}`);
  return 0;
}

// Returns the process exit code: 0 ok, 1 failed, 2 usage error.
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "hooks": return await hooks(args, io);
      case "report": return await report(args, io);
      case "send": return await send(args, io);
      case "daemon": return await daemon(args, io);
      case "run": return await run(args, io);
      case "status": return await status(args, io);
      case "resume": return await runAction("resume", args, io);
      case "clean": return await runAction("clean", args, io);
      case "project": return await project(args, io);
      case "bench": return await bench(args, io);
      default: throw new UsageError(command ? `unknown command "${command}"` : "no command given");
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`rivet: ${e.message}`);
      io.err(USAGE);
      return 2;
    }
    if (e instanceof DaemonDownError || e instanceof DaemonError) {
      io.err(`rivet: ${e.message}`);
      return 1;
    }
    io.err(`rivet: ${(e as Error).message}`);
    return 1;
  }
}
