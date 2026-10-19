import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git } from "../git.js";
import { defaultProjectId } from "../paths.js";
import { totalTokens, type TokenUse } from "../usage.js";
import type { Run } from "../store.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { readRunFile } from "../runfile.js";
import type { Probes } from "./doctor.js";
import { agentSessionIdOf, deriveActivity } from "./activity.js";
import { callDaemon, dataDirFrom, DaemonDownError, DaemonError, runFileFrom } from "./client.js";

export type CliIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  readStdin(): Promise<string>;
  // Asks the user a question (only when a terminal is attached).
  ask?(question: string): Promise<string>;
  // The real terminal, for attach (raw keys in, resize events).
  tty?: { input: NodeJS.ReadStream; output: NodeJS.WriteStream };
  // Replaces what doctor checks on this machine (tests).
  doctorProbes?: Probes;
  // Starts the daemon in the background (absent in tests that do not want it).
  startDaemon?(): Promise<void>;
  // Writes output exactly as received (a session's screen), without a newline.
  raw?(chunk: string): void;
  out(line: string): void;
  err(line: string): void;
};

const USAGE = `usage: rivet <command>
  spawn [--name <label>] [--agent <name>] [--model <id>] [--issue <n|owner/repo#n|url>] [--repo <dir>] [--base <branch>] [<task>]
                                        start a worker on a task in its own worktree
  orchestrator [--agent <name>] [--repo <dir>] [<what you want>]
                                        start an agent that splits work and spawns workers
  status [<run>]                        list sessions, or show one with its pull request
  stop <run> [--keep-workers]           stop a session; an orchestrator also stops its workers
  resume <run>                          retry what was escalated or interrupted
  pr <run>                              bring in the latest base, push and open the pull request
  review <run>                          have a reviewer agent review a worker's pull request
  review submit --verdict approved|changes_requested --summary <text> [--comment "<path>:<line>: <text>" ...]
                                        submit a review (inside a reviewer)
  clean <run>                           remove a run's worktree (the branch stays)
  merge-policy <run> terminate|keep     end the run once its pull request merges (default keep)
  project get|set <key> <value>|unset <key>
                                        settings for this repo: check, test, worker.agent
  attach <session>                      use a session's terminal (interactive mode); Ctrl-] detaches
  panes                                 show every running agent side by side
  daemon start|stop|status              run or control the background daemon
  doctor                                check what Rivet needs on this machine
  login claude|codex                    log an agent's CLI in to its account (its own login)
  hooks <agent> <event>                 receive an agent hook (called by the agent)
  report --done|--stuck|--needs-input --note <text>
                                        report this session's state (inside an agent)
  check                                 run the project's check and tests on this worktree (inside a worker)
  send --session <id> --message <text>  send a message to a running session`;

class UsageError extends Error {}

const HOOK_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 120_000;
// Starting a run creates every worktree and runs the project's setup (installs can be slow).
const RUN_TIMEOUT_MS = 60 * 60_000;
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
  const { delivery } = await callDaemon(io.env, "POST", `/api/v1/sessions/${encodeURIComponent(session)}/send`,
    { message, ...(from ? { from } : {}) }, COMMAND_TIMEOUT_MS) as { delivery?: string };
  io.out(delivery === "turn-end" ? `queued for ${session}: it runs headless and gets the message when its turn ends`
    : delivery === "next-launch" ? `queued for ${session}: it is not running and gets the message when it starts again`
    : `sent to ${session}`);
  return 0;
}

// "rivet review <run>" starts a review of a worker's pull request; "rivet review submit",
// run by the reviewer, hands its review to Rivet. --comment may be given many times.
async function review(args: string[], io: CliIo): Promise<number> {
  if (args[0] !== "submit") {
    const runId = args[0];
    if (!runId) throw new UsageError("review needs a run id, or submit");
    await callDaemon(io.env, "POST", `/api/v1/runs/${encodeURIComponent(runId)}/review`, undefined, COMMAND_TIMEOUT_MS);
    io.out(`review of ${runId} started; see it with rivet status ${runId}`);
    return 0;
  }
  const session = io.env.RIVET_SESSION_ID?.trim();
  if (!session) throw new UsageError("review submit runs inside a reviewer started by Rivet");
  let verdict: string | undefined;
  let summary: string | undefined;
  const comments: { path: string; line: number; body: string }[] = [];
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined || !["--verdict", "--summary", "--comment"].includes(flag!)) throw new UsageError(`unexpected ${flag}`);
    i++;
    if (flag === "--verdict") verdict = value;
    else if (flag === "--summary") summary = value;
    else {
      const m = /^(.+?):(\d+):\s*([\s\S]+)$/.exec(value);
      if (!m) throw new UsageError(`--comment must be "<path>:<line>: <finding>", got "${value}"`);
      comments.push({ path: m[1]!.trim(), line: Number(m[2]), body: m[3]!.trim() });
    }
  }
  if (verdict !== "approved" && verdict !== "changes_requested") throw new UsageError("review submit needs --verdict approved|changes_requested");
  if (!summary?.trim()) throw new UsageError("review submit needs --summary");
  await callDaemon(io.env, "POST", `/api/v1/sessions/${encodeURIComponent(session)}/review`, { verdict, summary, comments }, COMMAND_TIMEOUT_MS);
  io.out(`review submitted: ${verdict}${comments.length ? `, ${comments.length} comments` : ""}`);
  return 0;
}

// Run by a worker's agent: Rivet runs the project's check and tests on its worktree.
async function check(io: CliIo): Promise<number> {
  const session = io.env.RIVET_SESSION_ID?.trim();
  if (!session) throw new UsageError("check runs inside a worker started by Rivet");
  const result = await callDaemon(io.env, "POST", `/api/v1/sessions/${encodeURIComponent(session)}/check`, {}, RUN_TIMEOUT_MS) as { ok: boolean; output: string };
  (result.ok ? io.out : io.err)(result.output);
  return result.ok ? 0 : 1;
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
        // Problems handled in the background (a pull request that could not open) go to the log.
        onError: (e) => io.err(`${new Date().toISOString()} ${(e as Error)?.message ?? String(e)}`),
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

async function repoTop(dir: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--show-toplevel"], dir)).trim();
  } catch {
    throw new Error(`not a git repository: ${dir}`);
  }
}

// Starts one session on the daemon: a worker, or an orchestrator that starts workers.
async function startSession(args: string[], io: CliIo, role: "worker" | "orchestrator"): Promise<number> {
  const { flags, rest } = parseFlags(args, ["repo", "base", "agent", "name", "model", "issue"]);
  const task = rest.join(" ").trim();
  if (role === "worker" && !task && typeof flags.get("issue") !== "string") throw new UsageError("spawn needs a task description or --issue");
  const repo = await repoTop(resolve(io.cwd, typeof flags.get("repo") === "string" ? (flags.get("repo") as string) : "."));
  const text = (key: string) => (typeof flags.get(key) === "string" ? { [key]: flags.get(key) as string } : {});
  // Inside an orchestrator's session the new worker reports back to it.
  const from = io.env.RIVET_SESSION_ID?.trim();
  const result = await callDaemon(io.env, "POST", "/api/v1/runs", {
    repo, task, role, ...text("base"), ...text("agent"), ...text("name"), ...text("model"), ...text("issue"), ...(from ? { from } : {}),
  }, RUN_TIMEOUT_MS) as { runId: string };
  if (role === "orchestrator") io.out(`orchestrator ${result.runId} started; talk to it with: rivet attach ${result.runId}-agent`);
  else io.out(`worker ${result.runId} started; follow it with: rivet status ${result.runId}`);
  return 0;
}

function ago(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

// How long a session has worked: from its first start to when it finished (or now).
function elapsedMs(n: Run["node"], now: number): number | null {
  if (!n.startedAt) return null;
  return (n.finishedAt ? Date.parse(n.finishedAt) : now) - Date.parse(n.startedAt);
}

function duration(ms: number): string {
  return ago(new Date(0).toISOString(), ms);
}

// One session: what it is, where it stands, how long its agent has been quiet, and how
// long it has worked.
export function renderRun(run: Run, live: boolean, now: number, silent = false): string[] {
  const n = run.node;
  const label = run.name ? ` (${run.name})` : "";
  const lines = [`${run.role} ${run.id}${label}: ${n.status}  ${run.task.split(/\r?\n/)[0]}`];
  const parts = [`  session ${run.id}-${n.id}`, n.agent];
  if (n.activity) {
    const quiet = n.activity !== "active" && n.activity !== "exited" ? ` for ${ago(n.activityAt, now)}` : "";
    parts.push(silent ? `no signal for ${ago(n.activityAt, now)}` : `${n.activity}${quiet}`);
  }
  const worked = elapsedMs(n, now);
  if (worked !== null) parts.push(`[${n.finishedAt ? "took" : "working"} ${duration(worked)}]`);
  if (live) parts.push("[agent running]");
  if (run.orchestrator) parts.push(`[started by ${run.orchestrator}]`);
  lines.push(parts.join("  "));
  if (n.summary) lines.push(`  ${n.summary.split(/\r?\n/)[0]!.slice(0, 160)}`);
  return lines;
}

// Tokens, not money: on a subscription a price would not be what the run cost. The
// price-weighted figure counts the run in plain input tokens, so cheap cache reads do
// not dominate it.
export function usageLine(u: { conversations: number; tokens: TokenUse; inputEquivalent?: number }): string {
  const t = u.tokens;
  const weighted = u.inputEquivalent !== undefined ? `, worth ${u.inputEquivalent} input tokens at list-price ratios` : "";
  return `usage: ${totalTokens(t)} tokens over ${u.conversations} agent conversations${weighted} (input ${t.input}, cache write ${t.cacheWrite}, cache read ${t.cacheRead}, output ${t.output})`;
}

async function status(args: string[], io: CliIo): Promise<number> {
  const [runId] = args;
  if (!runId) {
    const { runs } = await callDaemon(io.env, "GET", "/api/v1/runs", undefined, COMMAND_TIMEOUT_MS) as {
      runs: { id: string; status: string; task: string; project: string; role: string; name: string; agent: string; live: boolean }[];
    };
    if (runs.length === 0) io.out("no sessions yet");
    for (const r of runs) {
      const label = r.name || r.task.split(/\r?\n/)[0]!.slice(0, 60);
      io.out(`${r.id}  ${r.role.padEnd(12)} ${r.status.padEnd(9)} ${r.agent.padEnd(6)} ${r.live ? "live " : "     "} ${label}  [${r.project}]`);
    }
    // Workers of one project that would clash when both land.
    for (const project of new Set(runs.map((r) => r.project))) {
      const { conflicts } = await callDaemon(io.env, "GET", `/api/v1/projects/${encodeURIComponent(project)}/radar`, undefined, COMMAND_TIMEOUT_MS)
        .catch(() => ({ conflicts: [] })) as { conflicts: { a: string; b: string; files: string[] }[] };
      for (const c of conflicts) io.out(`conflict radar: ${c.a} and ${c.b} would conflict in ${c.files.join(", ")}`);
    }
    return 0;
  }
  const result = await callDaemon(io.env, "GET", `/api/v1/runs/${encodeURIComponent(runId)}`, undefined, COMMAND_TIMEOUT_MS) as {
    run: Run; live: boolean; now: string; pr: { url: string } | null; noSignal?: boolean;
    usage?: { conversations: number; tokens: TokenUse; inputEquivalent?: number };
  };
  for (const line of renderRun(result.run, result.live, Date.parse(result.now), result.noSignal)) io.out(line);
  if (result.usage && result.usage.conversations > 0) io.out(usageLine(result.usage));
  if (result.pr) io.out(`pull request: ${result.pr.url} (${result.run.node.prStatus ?? "pr_open"})`);
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
    io.out(removed.length ? "removed its worktree (the branch stays)" : kept.length ? "kept its worktree: it has uncommitted work" : "nothing to remove");
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

const DETACH_KEY = "\u001d"; // Ctrl-]

// Your terminal becomes the session's: its screen streams in, your keys go to it.
async function attach(args: string[], io: CliIo): Promise<number> {
  const [sessionId] = args;
  if (!sessionId) throw new UsageError("attach needs a session id (see rivet status <run>)");
  const info = await readRunFile(runFileFrom(io.env));
  if (!info) throw new DaemonDownError();
  const base = `http://127.0.0.1:${info.port}/api/v1/sessions/${encodeURIComponent(sessionId)}`;
  const post = (action: string, body: unknown) => fetch(`${base}/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => undefined);
  const response = await fetch(`${base}/attach`).catch(() => { throw new DaemonDownError(); });
  if (!response.ok) {
    const text = await response.text();
    throw new DaemonError(response.status, (JSON.parse(text || "{}") as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  const reader = response.body!.getReader();
  const tty = io.tty;
  let detached = false;
  const onKeys = (data: Buffer) => {
    const text = data.toString("utf8");
    if (text.includes(DETACH_KEY)) { detached = true; void reader.cancel(); return; }
    void post("input", { data: text });
  };
  const onResize = () => { if (tty) void post("resize", { cols: tty.output.columns, rows: tty.output.rows }); };
  if (tty) {
    io.err(`attached to ${sessionId}; press Ctrl-] to detach`);
    tty.input.setRawMode?.(true);
    tty.input.resume();
    tty.input.on("data", onKeys);
    tty.output.on("resize", onResize);
    onResize();
  }
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      (io.raw ?? io.out)(decoder.decode(value, { stream: true }));
    }
  } catch {
    // Cancelled by the detach key.
  } finally {
    if (tty) {
      tty.input.off("data", onKeys);
      tty.output.off("resize", onResize);
      tty.input.setRawMode?.(false);
      tty.input.pause();
    }
  }
  io.err(detached ? `\r\ndetached from ${sessionId}` : `\r\nsession ${sessionId} ended`);
  return 0;
}

// Every running agent side by side (orchestrator and workers alike).
async function panes(io: CliIo): Promise<number> {
  const { runs } = await callDaemon(io.env, "GET", "/api/v1/runs", undefined, COMMAND_TIMEOUT_MS) as {
    runs: { id: string; task: string; name: string; role: string; live: boolean }[];
  };
  const sessions = runs.filter((r) => r.live).map((r) => ({ id: `${r.id}-agent`, title: `${r.role} ${r.name || r.task.slice(0, 40)}` }));
  if (sessions.length === 0) {
    io.out("no agent is running right now");
    return 1;
  }
  const runId = "rivet";
  const { panesPlan } = await import("./panes.js");
  const { rivetBinDir } = await import("../runtime/env.js");
  const { execFileSync, spawn } = await import("node:child_process");
  const have = (tool: string) => {
    try { execFileSync(process.platform === "win32" ? "where" : "which", [tool], { stdio: "ignore" }); return true; } catch { return false; }
  };
  const rivet = join(rivetBinDir(), process.platform === "win32" ? "rivet.cmd" : "rivet");
  const plan = panesPlan({ platform: process.platform, rivet, runId, sessions, have });
  if (plan.kind === "print") {
    io.out("no terminal multiplexer found; attach to each session in its own terminal:");
    for (const line of plan.lines) io.out(line);
    return 0;
  }
  if (plan.kind === "wt") {
    spawn(plan.file, plan.args, { detached: true, stdio: "ignore" }).unref();
    io.out(`opened ${sessions.length} panes in Windows Terminal`);
    return 0;
  }
  for (const step of plan.steps.slice(0, -1)) execFileSync("tmux", step, { stdio: "inherit" });
  execFileSync("tmux", plan.steps.at(-1)!, { stdio: "inherit" });
  return 0;
}

// Commands you type yourself start the daemon when it is down. Commands agents run
// (hooks, report, send) never do: their daemon is the one that started them.
const AUTOSTART = new Set(["spawn", "review", "orchestrator", "status", "stop", "resume", "clean", "merge-policy", "project", "pr", "attach", "panes"]);
const AUTOSTART_WAIT_MS = 15_000;

async function daemonUp(io: CliIo): Promise<boolean> {
  try {
    await callDaemon(io.env, "GET", "/healthz", undefined, 2_000);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(io: CliIo): Promise<void> {
  if (!io.startDaemon || io.env.RIVET_NO_AUTOSTART === "1" || (await daemonUp(io))) return;
  io.err("rivet: starting the daemon in the background");
  await io.startDaemon();
  const end = Date.now() + AUTOSTART_WAIT_MS;
  while (!(await daemonUp(io))) {
    if (Date.now() > end) throw new Error(`the daemon did not come up within ${AUTOSTART_WAIT_MS / 1000} s; see ${join(dataDirFrom(io.env), "daemon.log")}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Logging in is the agent CLI's own: Rivet runs its login in this terminal.
const LOGIN_ARGS: Record<string, string[]> = { claude: ["auth", "login"], codex: ["login"] };

async function login(args: string[], io: CliIo): Promise<number> {
  const name = args[0];
  if (!name || !LOGIN_ARGS[name]) throw new UsageError("login needs claude or codex");
  const { findClaude, findCodex } = await import("../agents/locate.js");
  const binary = name === "claude" ? findClaude() : findCodex();
  const { spawn } = await import("node:child_process");
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(binary, [...LOGIN_ARGS[name]!, ...args.slice(1)], { stdio: "inherit", windowsHide: false });
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code === 0) io.out(`${name} is logged in; check with rivet doctor`);
  return code === 0 ? 0 : 1;
}

async function doctorCommand(io: CliIo): Promise<number> {
  const { doctor, realProbes } = await import("./doctor.js");
  let probes = io.doctorProbes;
  if (!probes) {
    const { findClaude, findCodex } = await import("../agents/locate.js");
    const { loadPty } = await import("../runtime/runtime.js");
    const { githubToken } = await import("../github/github.js");
    const remote = (await git(["remote", "get-url", "origin"], io.cwd).catch(() => "")).trim();
    probes = realProbes({
      findClaude: () => findClaude(), findCodex: () => findCodex(), loadPty: () => loadPty() !== null,
      daemonUp: () => daemonUp(io), githubToken: () => githubToken(io.env, remote),
    });
  }
  const checks = await doctor(dataDirFrom(io.env), probes);
  for (const c of checks) io.out(`${(c.level === "fail" ? "FAIL" : c.level).padEnd(5)} ${c.name.padEnd(10)} ${c.message}`);
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

// Returns the process exit code: 0 ok, 1 failed, 2 usage error.
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (AUTOSTART.has(command ?? "")) await ensureDaemon(io);
    switch (command) {
      case "hooks": return await hooks(args, io);
      case "report": return await report(args, io);
      case "send": return await send(args, io);
      case "check": return await check(io);
      case "review": return await review(args, io);
      case "daemon": return await daemon(args, io);
      case "doctor": return await doctorCommand(io);
      case "login": return await login(args, io);
      case "spawn": return await startSession(args, io, "worker");
      case "orchestrator": return await startSession(args, io, "orchestrator");
      case "stop": {
        const { flags, rest } = parseFlags(args, []);
        const runId = rest[0];
        if (!runId) throw new UsageError("stop needs a run id");
        const { workers } = await callDaemon(io.env, "POST", `/api/v1/runs/${encodeURIComponent(runId)}/stop`,
          { keepWorkers: flags.get("keep-workers") === true }, COMMAND_TIMEOUT_MS) as { workers?: string[] };
        io.out(`stopped ${runId}${workers?.length ? ` and its workers ${workers.join(", ")}` : ""}`);
        return 0;
      }
      case "attach": return await attach(args, io);
      case "panes": return await panes(io);
      case "status": return await status(args, io);
      case "resume": return await runAction("resume", args, io);
      case "pr": {
        const [runId] = args;
        if (!runId) throw new UsageError("pr needs a run id");
        const pr = await callDaemon(io.env, "POST", `/api/v1/runs/${encodeURIComponent(runId)}/pr`, undefined, COMMAND_TIMEOUT_MS) as { url: string };
        io.out(`pull request: ${pr.url}`);
        return 0;
      }
      case "clean": return await runAction("clean", args, io);
      case "merge-policy": {
        const [runId, policy] = args;
        if (!runId || (policy !== "terminate" && policy !== "keep")) throw new UsageError("merge-policy needs <run> terminate|keep");
        await callDaemon(io.env, "PATCH", `/api/v1/runs/${encodeURIComponent(runId)}/merge-policy`, { terminateOnPrMerge: policy === "terminate" }, COMMAND_TIMEOUT_MS);
        io.out(policy === "terminate" ? `run ${runId} ends once its pull request merges` : `run ${runId} stays after its pull request merges`);
        return 0;
      }
      case "project": return await project(args, io);
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
