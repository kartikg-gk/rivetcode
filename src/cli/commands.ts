import { appendFile, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../daemon/server.js";
import { readRunFile } from "../runfile.js";
import { agentSessionIdOf, deriveActivity } from "./activity.js";
import { callDaemon, dataDirFrom, DaemonDownError, DaemonError, runFileFrom } from "./client.js";

export type CliIo = {
  env: Record<string, string | undefined>;
  readStdin(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
};

const USAGE = `usage: rivet <command>
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

// Returns the process exit code: 0 ok, 1 failed, 2 usage error.
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "hooks": return await hooks(args, io);
      case "report": return await report(args, io);
      case "send": return await send(args, io);
      case "daemon": return await daemon(args, io);
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
