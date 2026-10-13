import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git } from "../git.js";
import { defaultProjectId } from "../paths.js";
import type { Run } from "../store.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readRunFile } from "../runfile.js";
import { makePlan, planFiles, renderPlan, type PlannerRunner } from "../planner/planner.js";
import { claimsOverlap, type PlanNode } from "../tree.js";
import type { Probes } from "./doctor.js";
import { agentSessionIdOf, deriveActivity } from "./activity.js";
import { callDaemon, dataDirFrom, DaemonDownError, DaemonError, runFileFrom } from "./client.js";

export type CliIo = {
  env: Record<string, string | undefined>;
  cwd: string;
  readStdin(): Promise<string>;
  // Asks the user a question (only when a terminal is attached).
  ask?(question: string): Promise<string>;
  // Replaces the claude planner (tests).
  planner?(repo: string): PlannerRunner;
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
  plan [--repo <dir>] <task>             let the planner propose a task tree and preview it
  run [--plan <file>] [--yes] [--repo <dir>] [--base <branch>] [--agent <name>] <task>
                                        start a run (plans first when no --plan is given)
  status [<run>]                        list runs, or show one run's tree
  resume <run>                          retry what was escalated or interrupted
  pr <run>                              bring in the latest base, push and open the pull request
  skip <run> <node>                     ship without a leaf (it keeps running for a follow-up)
  sync [<session>]                      bring the parent's merged work into a running leaf
  clean <run>                           remove a run's worktrees (branches stay)
  merge-policy <run> terminate|keep     end the run once its pull request merges (default keep)
  project get|set <key> <value>|unset <key>
                                        settings for this repo: check, test, worker.agent
  bench <spec.json>                     compare ways of splitting one task (e.g. single, flat, tree)
  attach <session>                      use a session's terminal (interactive mode); Ctrl-] detaches
  panes <run>                           show every running agent of a run side by side
  daemon start|stop|status              run or control the background daemon
  doctor                                check what Rivet needs on this machine
  hooks <agent> <event>                 receive an agent hook (called by the agent)
  report --done|--stuck|--needs-input --note <text>
                                        report this session's state (inside an agent)
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

async function repoTop(dir: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--show-toplevel"], dir)).trim();
  } catch {
    throw new Error(`not a git repository: ${dir}`);
  }
}

// The planner's model comes from the project settings when the daemon is up.
async function defaultPlanner(io: CliIo, repo: string): Promise<PlannerRunner> {
  const { findClaude } = await import("../agents/locate.js");
  const { claudePlanner } = await import("../planner/claude-runner.js");
  const config = await callDaemon(io.env, "GET", `/api/v1/projects/${encodeURIComponent(defaultProjectId(repo))}/config`, undefined, HOOK_TIMEOUT_MS)
    .catch(() => ({})) as Record<string, string>;
  const model = config["planner.model"] ?? config["worker.model"];
  return claudePlanner({ binary: findClaude(), repo, ...(model ? { model } : {}) });
}

// Files the plan claims that a run in flight is already touching.
async function overlaps(io: CliIo, repo: string, plan: PlanNode): Promise<string[]> {
  const result = await callDaemon(io.env, "GET", `/api/v1/projects/${encodeURIComponent(defaultProjectId(repo))}/active-files`, undefined, COMMAND_TIMEOUT_MS)
    .catch(() => ({ files: [] })) as { files: { file: string; runId: string; nodeId: string }[] };
  const warnings: string[] = [];
  for (const mine of planFiles(plan)) {
    for (const theirs of result.files) {
      if (claimsOverlap(mine, theirs.file)) warnings.push(`${mine} overlaps ${theirs.file} (run ${theirs.runId}, ${theirs.nodeId})`);
    }
  }
  return warnings;
}

async function planAndPreview(io: CliIo, repo: string, task: string, agent: string): Promise<{ plan: PlanNode; file: string; warnings: string[] }> {
  io.out("planning...");
  const runner = io.planner ? io.planner(repo) : await defaultPlanner(io, repo);
  const plan = await makePlan(task, runner);
  const dir = join(dataDirFrom(io.env), "plans");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `plan-${Date.now()}.json`);
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
  for (const line of renderPlan(plan, agent)) io.out(line);
  const warnings = await overlaps(io, repo, plan);
  for (const w of warnings) io.out(`warning: ${w}`);
  io.out(`plan saved to ${file}`);
  return { plan, file, warnings };
}

async function planCommand(args: string[], io: CliIo): Promise<number> {
  const { flags, rest } = parseFlags(args, ["repo", "agent"]);
  const task = rest.join(" ").trim();
  if (!task) throw new UsageError("plan needs a task description");
  const repo = await repoTop(resolve(io.cwd, typeof flags.get("repo") === "string" ? (flags.get("repo") as string) : "."));
  const agent = typeof flags.get("agent") === "string" ? (flags.get("agent") as string) : "claude";
  const { file } = await planAndPreview(io, repo, task, agent);
  io.out(`start it with: rivet run --plan "${file}" ${task}`);
  return 0;
}

async function run(args: string[], io: CliIo): Promise<number> {
  const { flags, rest } = parseFlags(args, ["plan", "repo", "base", "agent"]);
  const planFile = flags.get("plan");
  const task = rest.join(" ").trim();
  if (!task) throw new UsageError("run needs a task description");
  const repo = await repoTop(resolve(io.cwd, typeof flags.get("repo") === "string" ? (flags.get("repo") as string) : "."));
  const base = flags.get("base");
  const agent = flags.get("agent");
  let plan: unknown;
  if (typeof planFile === "string") {
    try {
      plan = JSON.parse(await readFile(resolve(io.cwd, planFile), "utf8"));
    } catch (e) {
      throw new Error(`could not read plan ${planFile}: ${(e as Error).message}`);
    }
  } else {
    // No plan given: the planner proposes one and the user decides.
    const preview = await planAndPreview(io, repo, task, typeof agent === "string" ? agent : "claude");
    plan = preview.plan;
    if (!flags.has("yes")) {
      if (!io.ask) {
        io.out(`not starting without confirmation; rerun with --yes or: rivet run --plan "${preview.file}" ${task}`);
        return 1;
      }
      const answer = (await io.ask("run this plan? [y]es / [e]dit / [n]o: ")).trim().toLowerCase();
      if (answer.startsWith("e")) {
        io.out(`edit ${preview.file}, then: rivet run --plan "${preview.file}" ${task}`);
        return 0;
      }
      if (!answer.startsWith("y")) {
        io.out("cancelled");
        return 0;
      }
    }
  }
  const result = await callDaemon(io.env, "POST", "/api/v1/runs", {
    repo, task, plan,
    ...(typeof base === "string" ? { base } : {}),
    ...(typeof agent === "string" ? { agent } : {}),
  }, RUN_TIMEOUT_MS) as { runId: string };
  io.out(`run ${result.runId} started; follow it with: rivet status ${result.runId}`);
  return 0;
}

function ago(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

// How long a leaf has worked: from its first start to when it finished (or now).
function elapsedMs(n: Run["nodes"][number], now: number): number | null {
  if (!n.startedAt) return null;
  return (n.finishedAt ? Date.parse(n.finishedAt) : now) - Date.parse(n.startedAt);
}

function duration(ms: number): string {
  return ago(new Date(0).toISOString(), ms);
}

// A running leaf against its finished siblings (the median of their times). Display only.
function versusSiblings(run: Run, n: Run["nodes"][number], now: number): string {
  if (n.finishedAt || n.status !== "running") return "";
  const mine = elapsedMs(n, now);
  const done = run.nodes
    .filter((s) => s.id !== n.id && s.kind === "leaf" && s.parentId === n.parentId && s.finishedAt)
    .map((s) => elapsedMs(s, now))
    .filter((ms): ms is number => ms !== null && ms > 0)
    .sort((a, b) => a - b);
  if (mine === null || done.length === 0) return "";
  const median = done[Math.floor(done.length / 2)]!;
  return `, ${(mine / median).toFixed(1)}x finished siblings`;
}

// One line per node: what it is, where it stands, how long its agent has been quiet, and
// how long it has worked compared with its siblings.
export function renderRun(run: Run, live: Record<string, boolean>, now: number, silent: string[] = []): string[] {
  const lines = [`run ${run.id} (root: ${run.nodes[0]!.status}) ${run.task}`];
  for (const n of run.nodes) {
    const name = `${"  ".repeat(n.depth)}${n.id} ${n.title}`;
    const parts = [name.padEnd(34), n.status.padEnd(11)];
    if (n.kind === "leaf" && n.activity) {
      const quiet = n.activity !== "active" && n.activity !== "exited" ? ` for ${ago(n.activityAt, now)}` : "";
      parts.push((silent.includes(n.id) ? `no signal for ${ago(n.activityAt, now)}` : `${n.activity}${quiet}`).padEnd(20));
    } else {
      parts.push("".padEnd(20));
    }
    const worked = n.kind === "leaf" ? elapsedMs(n, now) : null;
    if (worked !== null) parts.push(`[${n.finishedAt ? "took" : "working"} ${duration(worked)}${versusSiblings(run, n, now)}]`);
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
    run: Run; live: Record<string, boolean>; now: string; pr: { url: string } | null; noSignal?: string[];
  };
  for (const line of renderRun(result.run, result.live, Date.parse(result.now), result.noSignal)) io.out(line);
  if (result.pr) io.out(`pull request: ${result.pr.url} (${result.run.nodes[0]!.prStatus ?? "pr_open"})`);
  const { conflicts } = await callDaemon(io.env, "GET", `/api/v1/runs/${encodeURIComponent(runId)}/radar`, undefined, COMMAND_TIMEOUT_MS)
    .catch(() => ({ conflicts: [] })) as { conflicts: { a: string; b: string; files: string[] }[] };
  for (const c of conflicts) io.out(`conflict radar: ${c.a} and ${c.b} would conflict in ${c.files.join(", ")}`);
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

async function panes(args: string[], io: CliIo): Promise<number> {
  const [runId] = args;
  if (!runId) throw new UsageError("panes needs a run id");
  const { run, live } = await callDaemon(io.env, "GET", `/api/v1/runs/${encodeURIComponent(runId)}`, undefined, COMMAND_TIMEOUT_MS) as {
    run: Run; live: Record<string, boolean>;
  };
  const sessions = run.nodes.filter((n) => live[n.id]).map((n) => ({ id: `${run.id}-${n.id}`, title: `${n.id} ${n.title}` }));
  if (sessions.length === 0) {
    io.out(`no agent of run ${runId} is running right now`);
    return 1;
  }
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
// (hooks, report, send, sync) never do: their daemon is the one that started them.
const AUTOSTART = new Set(["run", "plan", "status", "resume", "clean", "merge-policy", "project", "pr", "skip", "attach", "panes"]);
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
      case "daemon": return await daemon(args, io);
      case "doctor": return await doctorCommand(io);
      case "run": return await run(args, io);
      case "plan": return await planCommand(args, io);
      case "attach": return await attach(args, io);
      case "panes": return await panes(args, io);
      case "status": return await status(args, io);
      case "resume": return await runAction("resume", args, io);
      case "sync": {
        // Inside an agent: sync this session, and the agent resolves any conflict itself.
        const self = io.env.RIVET_SESSION_ID?.trim();
        const target = args[0] ?? self;
        if (!target) throw new UsageError("sync needs a session id (or run it inside an agent session)");
        const result = await callDaemon(io.env, "POST", `/api/v1/sessions/${encodeURIComponent(target)}/sync`,
          { byAgent: !args[0] && !!self }, COMMAND_TIMEOUT_MS) as { synced: boolean; conflicts: string[]; note: string };
        io.out(result.synced ? `synced: ${result.note}` : `conflicts in ${result.conflicts.join(", ")}: ${result.note}`);
        return result.synced ? 0 : 1;
      }
      case "skip": {
        const [runId, node] = args;
        if (!runId || !node) throw new UsageError("skip needs <run> <node>");
        await callDaemon(io.env, "POST", `/api/v1/runs/${encodeURIComponent(runId)}/skip`, { node }, COMMAND_TIMEOUT_MS);
        io.out(`${node} skipped; the run goes on without it (a running agent keeps going for a follow-up)`);
        return 0;
      }
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
