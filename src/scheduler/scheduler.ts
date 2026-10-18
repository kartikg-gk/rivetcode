import { existsSync } from "node:fs";
import { git } from "../git.js";
import type { Agent } from "../agents/agent.js";
import { abortMerge, commitLeftovers, finishResolution, headOf, mergeBranch, resetTo, runCommand, workingTree } from "../merge.js";
import { normalizePermission } from "../agents/command.js";
import { agentEnv, sessionIdOf } from "../runtime/env.js";
import { newLaunchId, type Runtime } from "../runtime/runtime.js";
import type { PullRequest, Run, Store } from "../store.js";
import { NODE_ID, setStatus, type Node, type Status } from "../model.js";
import { prStatus, type GitHub } from "../github/github.js";
import { checkNote, conflictPrompt, orchestratorPrompt, workerPrompt } from "./prompts.js";
import { radar } from "./radar.js";
import { cleanRun } from "./runs.js";

// Agents edit files and run rivet and git on their own; a project can widen or narrow this.
export const DEFAULT_PERMISSION = "accept-edits";
export const DEFAULT_ALLOWED_TOOLS = "Bash(rivet:*),Bash(git:*)";

// Runners whose next word names the tool ("uv run ruff", "npx tsc"); for the rest the
// first word is the tool. Bare interpreters are never opened up as a whole.
const RUNNERS = [["uv", "run"], ["poetry", "run"], ["pipx", "run"], ["python", "-m"], ["python3", "-m"], ["npm", "run"], ["pnpm", "run"], ["yarn", "run"], ["npx"], ["pnpx"], ["bunx"]];
const INTERPRETERS = new Set(["node", "python", "python3", "py", "bash", "sh", "cmd", "powershell", "pwsh", "deno", "bun"]);

// Permission rules that let an agent run a project command the way it will need to:
// the whole command, each step of a compound one (agents' permission checks look at
// every step of "a && b" on its own), and each step's tool with other arguments
// (for example "uv run ruff check --fix" next to the configured "uv run ruff check src").
export function commandRules(command: string): string[] {
  const rules = new Set<string>([`Bash(${command})`, `Bash(${command}:*)`]);
  for (const step of command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean)) {
    rules.add(`Bash(${step})`);
    rules.add(`Bash(${step}:*)`);
    const words = step.split(/\s+/);
    const runner = RUNNERS.find((r) => r.every((w, i) => words[i] === w));
    if (runner && words.length > runner.length) rules.add(`Bash(${words.slice(0, runner.length + 1).join(" ")}:*)`);
    else if (!runner && !INTERPRETERS.has(words[0]!)) rules.add(`Bash(${words[0]}:*)`);
  }
  return [...rules];
}

// What an orchestrator brought back by resume is told before anything else.
const RESTART_NOTE = "Rivet was restarted. Before starting anything, run rivet status: workers you started earlier may still be running or already done, so do not start the same work again.";

// A worker gets this many launches before Rivet stops retrying and asks the user.
export const MAX_ATTEMPTS = 2;
const OUTPUT_FOR_RETRY = 40;

export type SchedulerDeps = {
  data: string;
  runFile: string;
  store: Store;
  // Serialises every store access; the store itself is synchronous.
  write<T>(work: () => T): Promise<T>;
  runtime: Runtime;
  agents(name: Node["agent"]): Agent;
  // Current launch per session, shared with the daemon so stale hooks can be ignored.
  launches: Map<string, string>;
  checkTimeoutMs?: number;
  testTimeoutMs?: number;
  // GitHub access for a run's repository; without it there are no pull requests.
  github?(run: Run): Promise<GitHub>;
  // Called with every problem the scheduler could not handle itself (for logs and tests).
  onError?(error: unknown): void;
};

export class SchedulerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SchedulerError";
  }
}

// Drives sessions: starts each worker's agent, checks its work when it says it is done,
// retries once, opens its pull request and sends feedback on it back to the worker.
// An orchestrator session only gets its agent started; it coordinates through the CLI.
export function createScheduler(d: SchedulerDeps) {
  const checkTimeout = d.checkTimeoutMs ?? 10 * 60_000;
  const testTimeout = d.testTimeoutMs ?? 30 * 60_000;
  const exitWaiters = new Map<string, (code: number | null) => void>();
  const doneReported = new Set<string>();
  // Sessions stopped on purpose (by the user or a shutdown): their exit is not a failure.
  const stoppedOnPurpose = new Set<string>();
  // Work still going on in the background (checks, pull requests), for idle().
  const pending = new Set<Promise<unknown>>();
  let shuttingDown = false;
  const report = (e: unknown) => d.onError?.(e);

  const load = (runId: string) => d.write(() => d.store.loadRun(runId));
  const sessionOf = (run: Run) => sessionIdOf(run.id, run.node.id);

  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }

  // Validated status change on fresh state; touches only the status fields.
  function transition(runId: string, to: Status, summary?: string): Promise<Node> {
    return d.write(() => {
      const node = setStatus(d.store.loadRun(runId).node, to, summary);
      d.store.updateNode(runId, node.id, {
        status: node.status, attempts: node.attempts, ...(summary !== undefined ? { summary } : {}),
      });
      return node;
    });
  }

  // resume: continue the agent's last conversation (the one its hooks reported) instead
  // of starting a new one.
  async function launch(run: Run, prompt?: string, o: { resume?: boolean } = {}): Promise<string> {
    const node = run.node;
    const sessionId = sessionOf(run);
    if (d.runtime.isAlive(sessionId)) throw new SchedulerError(409, "session is already running");
    if (!existsSync(node.worktree)) throw new SchedulerError(409, `worktree is missing: ${node.worktree}`);
    const agent = d.agents(node.agent);
    const launchId = newLaunchId();
    const config = await d.write(() => d.store.getConfig(run.project));
    const model = run.model ?? config["worker.model"]?.trim();
    const allowedTools = (config["worker.allowedTools"] ?? DEFAULT_ALLOWED_TOOLS).split(",").map((t) => t.trim()).filter(Boolean);
    const worker = run.role === "worker";
    if (worker) {
      // The agent must be able to run what Rivet will judge its work by.
      for (const command of [config.check, config.test].map((c) => c?.trim()).filter((c): c is string => !!c)) {
        for (const rule of commandRules(command)) if (!allowedTools.includes(rule)) allowedTools.push(rule);
      }
      const check = config.check?.trim();
      if (check && prompt !== undefined && node.agent !== "fake" && !o.resume) prompt += checkNote(check, config["verify.reuse"] !== "off");
    }
    // An orchestrator is someone you talk to, so it always gets a terminal (the test fake
    // has none). A worker runs headless unless the project asks for terminals.
    const headless = worker ? config["worker.mode"] !== "interactive" : node.agent === "fake";
    const cfg = {
      sessionId, workspace: node.worktree, headless,
      permission: normalizePermission(config["worker.permission"] ?? DEFAULT_PERMISSION),
      ...(model ? { model } : {}),
      ...(allowedTools.length ? { allowedTools } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    };
    const argv = o.resume
      ? await agent.restoreCommand({ ...cfg, ...(node.agentSessionId ? { capturedId: node.agentSessionId } : {}) })
      : await agent.launchCommand(cfg);
    if (!argv) throw new SchedulerError(409, `${run.id} has no conversation to resume`);
    await agent.installHooks(node.worktree);
    await agent.prepare?.({ workspace: node.worktree, headless });
    // Recorded before the process exists, so even an instant exit is attributed to it.
    const previous = d.launches.get(sessionId);
    d.launches.set(sessionId, launchId);
    try {
      await d.runtime.start({
        sessionId, workspace: node.worktree, argv, launchId,
        ...(headless
          ? { stdin: agent.acceptsInput({ headless: true }) ? "pipe" as const : "ignore" as const }
          : { terminal: { cols: 120, rows: 40 } }),
        env: {
          ...agentEnv({ runId: run.id, nodeId: node.id, project: run.project, dataDir: d.data, runFile: d.runFile, launchId }),
          RIVET_ATTEMPT: String(node.attempts),
        },
      });
    } catch (e) {
      if (d.launches.get(sessionId) === launchId) {
        if (previous === undefined) d.launches.delete(sessionId);
        else d.launches.set(sessionId, previous);
      }
      if (d.runtime.isAlive(sessionId)) throw new SchedulerError(409, "session is already running");
      throw e;
    }
    doneReported.delete(sessionId);
    await d.write(() => d.store.markLaunched(run.id, node.id));
    await deliverQueued(run.id);
    return launchId;
  }

  // One delivery pass per session at a time, so two sends never type a message twice.
  const delivering = new Map<string, Promise<void>>();
  function deliverQueued(runId: string): Promise<void> {
    const sessionId = sessionIdOf(runId, NODE_ID);
    const next = (delivering.get(sessionId) ?? Promise.resolve()).then(() => deliverNow(runId));
    const tail = next.catch(() => {});
    delivering.set(sessionId, tail);
    void tail.then(() => { if (delivering.get(sessionId) === tail) delivering.delete(sessionId); });
    return next;
  }

  async function deliverNow(runId: string): Promise<void> {
    const sessionId = sessionIdOf(runId, NODE_ID);
    const queued = await d.write(() => d.store.undeliveredMessages(runId, NODE_ID));
    for (const m of queued) {
      // A headless agent gets its messages when its turn ends (see messagesAtTurnEnd).
      if (!d.runtime.takesInput(sessionId)) return;
      try { await d.runtime.write(sessionId, m.message); } catch { return; }
      await d.write(() => d.store.markDelivered(m.id));
    }
  }

  function firstPrompt(run: Run, retry?: string): string {
    return run.role === "orchestrator" ? orchestratorPrompt(run) : workerPrompt(run, retry);
  }

  // Starts (or restarts) a session: counts an attempt and launches its agent.
  async function runSession(runId: string, retry?: string): Promise<void> {
    await transition(runId, "running");
    await d.write(() => d.store.updateNode(runId, NODE_ID, { finishedAt: null }));
    const run = await load(runId);
    await launch(run, firstPrompt(run, retry));
  }

  async function startRun(runId: string): Promise<void> {
    const run = await load(runId);
    if (run.node.status !== "pending") throw new SchedulerError(409, `run ${runId} has already started`);
    await runSession(runId).catch(async (e) => {
      await transition(runId, "escalated", `could not start: ${(e as Error).message}`).catch(report);
      report(e);
    });
  }

  // The project's check, then its tests, on a worker's worktree as it is now.
  async function verify(run: Run): Promise<{ ok: true } | { ok: false; why: string }> {
    const config = await d.write(() => d.store.getConfig(run.project));
    for (const [what, command, timeout] of [["check", config.check, checkTimeout], ["tests", config.test, testTimeout]] as const) {
      if (!command) continue;
      const result = await runCommand(command, run.node.worktree, timeout);
      if (!result.ok) return { ok: false, why: `${what} "${command}" failed on the finished work:\n${result.output}` };
    }
    return { ok: true };
  }

  // Worktree states whose check and tests a worker got to pass with "rivet check".
  const passed = new Map<string, string>();

  // "rivet check" from a worker: Rivet runs the check and tests for it and remembers a
  // pass, so the same files are not checked again when it reports done.
  async function agentCheck(runId: string): Promise<{ ok: boolean; output: string }> {
    const run = await load(runId);
    if (run.role !== "worker") throw new SchedulerError(409, "only a worker runs the check");
    const tree = await workingTree(run.node.worktree);
    const result = await verify(run);
    if (!result.ok) {
      passed.delete(runId);
      return { ok: false, output: result.why };
    }
    passed.set(runId, tree);
    return { ok: true, output: "check and tests passed" };
  }

  // A worker says it is done: its leftovers are committed, the check and the tests
  // decide, and a pass opens or updates its pull request. A pass the worker already got
  // from "rivet check" on these exact files counts, unless the project turned that off.
  async function workFinished(runId: string): Promise<void> {
    const run = await load(runId);
    if (run.node.status !== "running" || run.node.finishedAt) return;
    await commitLeftovers(run.node.worktree, `rivet: save work left uncommitted by "${run.node.title}"`);
    // Any failure noted on an earlier attempt is over now.
    await d.write(() => d.store.updateNode(runId, NODE_ID, { finishedAt: new Date().toISOString(), summary: null }));
    const config = await d.write(() => d.store.getConfig(run.project));
    const reused = config["verify.reuse"] !== "off" && passed.get(runId) === await workingTree(run.node.worktree);
    passed.delete(runId);
    if (!reused) {
      const result = await verify(run);
      if (!result.ok) {
        await workFailed(runId, result.why);
        return;
      }
    }
    await transition(runId, "done");
    await tellOrchestrator(run, `Worker ${run.id}${run.name ? ` (${run.name})` : ""} is done and its check passed.`);
    // A run with a pull request pushes every new result; "pr=auto" opens one the first time.
    const hasPr = (await d.write(() => d.store.getPr(runId))) !== null;
    if (d.github && (hasPr || config.pr === "auto")) await publish(runId).catch(report);
  }

  // Retry once, then hand it to the user.
  async function workFailed(runId: string, why: string): Promise<void> {
    const run = await load(runId);
    if (run.node.status !== "running") return;
    if (run.node.attempts < MAX_ATTEMPTS) {
      await transition(runId, "failed", why);
      await runSession(runId, why);
      return;
    }
    await transition(runId, "escalated", `gave up after ${run.node.attempts} attempts: ${why}`);
    await tellOrchestrator(run, `Worker ${run.id}${run.name ? ` (${run.name})` : ""} gave up: ${why.split(/\r?\n/)[0]}`);
  }

  function lastOutput(sessionId: string): string {
    return (d.runtime.output(sessionId, OUTPUT_FOR_RETRY)?.lines ?? []).join("\n");
  }

  async function onExit(sessionId: string, launchId: string, code: number | null): Promise<void> {
    if (d.launches.get(sessionId) !== launchId) return;
    const waiter = exitWaiters.get(launchId);
    const runId = sessionId.slice(0, sessionId.indexOf("-"));
    await d.write(() => d.store.setActivity(runId, NODE_ID, "exited"));
    if (waiter) {
      exitWaiters.delete(launchId);
      waiter(code);
      return;
    }
    if (shuttingDown) return;
    if (stoppedOnPurpose.delete(sessionId) && !doneReported.has(sessionId)) return;
    let run: Run;
    try { run = await load(runId); } catch { return; }
    // An orchestrator's exit ends nothing but its own conversation.
    if (run.role !== "worker") return;
    if (code === 0 || doneReported.has(sessionId)) {
      if (await messagesAtTurnEnd(run)) return;
      await track(workFinished(runId));
    } else await workFailed(runId, `agent exited with code ${code}\n${lastOutput(sessionId)}`);
  }

  // A headless agent could not read messages sent while it worked. Before its work is
  // taken, its conversation is resumed once with them; that turn's end is its finish.
  // False when there is nothing to deliver or no conversation to resume (they then wait
  // for the next launch).
  async function messagesAtTurnEnd(run: Run): Promise<boolean> {
    const queued = await d.write(() => d.store.undeliveredMessages(run.id, NODE_ID));
    if (queued.length === 0) return false;
    const prompt = [
      "Messages arrived while you worked on your task:",
      ...queued.map((m) => `- ${m.message}`),
      "",
      "Act on them if they change your task and commit any change, then report done again.",
    ].join("\n");
    try {
      await launch(run, prompt, { resume: true });
    } catch (e) {
      report(e);
      return false;
    }
    for (const m of queued) await d.write(() => d.store.markDelivered(m.id));
    return true;
  }

  // Hands a worker's news to the orchestrator that started it, if it has one.
  async function tellOrchestrator(run: Run, message: string): Promise<void> {
    if (!run.orchestrator) return;
    const target = run.orchestrator.slice(0, run.orchestrator.indexOf("-"));
    const id = await d.write(() => d.store.queueMessage(target, NODE_ID, message, sessionOf(run)));
    if (id !== null) await deliverQueued(target).catch(report);
  }

  // "rivet report": every report goes on to the worker's orchestrator; "--done" also
  // stops the agent and takes the work.
  async function onReport(runId: string, kind: string, note?: string): Promise<void> {
    const run = await load(runId);
    await tellOrchestrator(run, `Worker ${run.id}${run.name ? ` (${run.name})` : ""} reports ${kind}${note ? `: ${note}` : ""}`);
    if (kind !== "done" || run.role !== "worker") return;
    const sessionId = sessionOf(run);
    doneReported.add(sessionId);
    if (d.runtime.isAlive(sessionId)) await d.runtime.stop(sessionId);
  }

  // Stops an agent without treating its exit as a failure; resume or a restart relaunches it.
  async function stopSession(sessionId: string): Promise<void> {
    if (!d.runtime.isAlive(sessionId)) return;
    stoppedOnPurpose.add(sessionId);
    await d.runtime.stop(sessionId);
  }

  // From now on exits are only recorded; nothing is retried.
  async function shutdown(): Promise<void> {
    shuttingDown = true;
    if (watcher) clearInterval(watcher);
    if (radarTimer) clearInterval(radarTimer);
    await d.runtime.stopAll();
    await idle();
  }

  // Runs the worker's agent on a conflict in its own branch and waits for it to finish.
  async function resolveWithAgent(run: Run, conflicts: string[]): Promise<{ ok: boolean; reason: string }> {
    const sessionId = sessionOf(run);
    let exited!: Promise<number | null>;
    try {
      const launchId = await launch(run, conflictPrompt(run, conflicts));
      exited = new Promise((resolve) => exitWaiters.set(launchId, resolve));
      if (!d.runtime.isAlive(sessionId)) {
        // Exited before we listened.
        exitWaiters.delete(launchId);
        exited = Promise.resolve(d.runtime.output(sessionId, 1)?.exitCode ?? null);
      }
    } catch (e) {
      return { ok: false, reason: `could not start the worker's agent: ${(e as Error).message}` };
    }
    await exited;
    const result = await finishResolution(run.node.worktree, conflicts);
    return result.ok ? { ok: true, reason: "" } : { ok: false, reason: result.reason };
  }

  async function filesChanged(run: Run): Promise<string[]> {
    const out = await git(["diff", "--name-only", `${run.base}...${run.node.branch}`], run.repo).catch(() => "");
    return out.split(/\r?\n/).filter(Boolean);
  }

  async function prBody(run: Run): Promise<string> {
    const files = await filesChanged(run);
    return [
      run.task,
      "",
      `Done by one agent (${run.node.agent}) in its own worktree on \`${run.node.branch}\`.`,
      ...(files.length ? ["", `Files: ${files.map((f) => `\`${f}\``).join(", ")}`] : []),
    ].join("\n");
  }

  // Brings the latest base into the finished work, tests again if it moved, pushes the
  // branch and opens the pull request if there is none yet. Never merges the PR.
  async function publish(runId: string): Promise<{ number: number; url: string }> {
    if (!d.github) throw new SchedulerError(409, "GitHub is not available");
    const run = await load(runId);
    const node = run.node;
    if (run.role !== "worker") throw new SchedulerError(409, "only a worker opens a pull request");
    if (node.status !== "done") throw new SchedulerError(409, `run ${runId} is not done (it is ${node.status})`);
    const before = await headOf(node.worktree);
    try {
      await git(["fetch", "-q", "origin", run.base], node.worktree);
    } catch (e) {
      throw new SchedulerError(409, `cannot fetch ${run.base} from origin: ${(e as Error).message}`);
    }
    const synced = await mergeBranch(node.worktree, `origin/${run.base}`, `Merge latest ${run.base}`);
    if (!synced.ok) {
      const resolved = await resolveWithAgent(run, synced.conflicts);
      if (!resolved.ok) {
        await abortMerge(node.worktree).catch(report);
        if ((await headOf(node.worktree)) !== before) await resetTo(node.worktree, before).catch(report);
        const why = `merging the latest ${run.base} conflicts in ${synced.conflicts.join(", ")}: ${resolved.reason}`;
        await d.write(() => d.store.updateNode(runId, NODE_ID, { summary: why, prStatus: "needs_input" }));
        throw new SchedulerError(409, why);
      }
    }
    if ((await headOf(node.worktree)) !== before) {
      const { test } = await d.write(() => d.store.getConfig(run.project));
      if (test) {
        const result = await runCommand(test, node.worktree, testTimeout);
        if (!result.ok) {
          await resetTo(node.worktree, before);
          const why = `tests "${test}" fail after merging the latest ${run.base}:\n${result.output}`;
          await d.write(() => d.store.updateNode(runId, NODE_ID, { summary: why, prStatus: "needs_input" }));
          throw new SchedulerError(409, why);
        }
      }
    }
    await git(["push", "-q", "origin", `HEAD:refs/heads/${node.branch}`], node.worktree);
    const existing = await d.write(() => d.store.getPr(runId));
    if (existing) return { number: existing.number, url: existing.url };
    const github = await d.github(run);
    const title = run.name || run.task.split(/\r?\n/)[0]!.slice(0, 120);
    const pr = await github.createPr({ title, head: node.branch, base: run.base, body: await prBody(run) });
    await d.write(() => {
      d.store.setPr(runId, pr);
      d.store.updateNode(runId, NODE_ID, { prStatus: "pr_open" });
    });
    return pr;
  }

  // Sends finished work back to its worker with feedback from the pull request.
  async function reopen(runId: string, feedback: string): Promise<void> {
    await transition(runId, "running", feedback);
    await d.write(() => d.store.updateNode(runId, NODE_ID, { finishedAt: null }));
    const run = await load(runId);
    await launch(run, workerPrompt(run, feedback));
  }

  // One look at the pull request: record where it stands and act once on new feedback.
  async function checkPr(runId: string): Promise<string | null> {
    if (!d.github) return null;
    const pr = await d.write(() => d.store.getPr(runId));
    if (!pr) return null;
    const run = await load(runId);
    const node = run.node;
    // Runs saved before a run was one session are left as they were.
    if (node.id !== NODE_ID) return null;
    if (node.prStatus === "merged") {
      await terminateAfterMerge(run, pr);
      return "merged";
    }
    if (node.prStatus === "terminated") return node.prStatus;
    const github = await d.github(run);
    const facts = await github.facts(pr.number);
    const status = prStatus(facts);
    await d.write(() => d.store.updateNode(runId, NODE_ID, { prStatus: status }));
    if (status === "merged") {
      await terminateAfterMerge(await load(runId), pr);
      return status;
    }
    const key = `${status}:${facts.mergeability}:${facts.headSha}`;
    // Work is already under way, or this exact state was handled before.
    if (pr.handled === key || node.status !== "done") return status;
    if (status === "ci_failed") {
      const paths = await github.failedPaths(pr.number);
      await reopen(runId, `CI failed on the pull request${paths.length ? ` in: ${paths.join(", ")}` : ""}. Fix it.`);
    } else if (status === "changes_requested") {
      const comments = await github.reviewComments(pr.number);
      const text = comments.map((c) => `${c.path}${c.line ? `:${c.line}` : ""}: ${c.body}`).join("\n");
      await reopen(runId, `Review comments on the pull request:\n${text}\nAddress them.`);
    } else if (facts.mergeability === "behind" || facts.mergeability === "conflicting") {
      await publish(runId).catch(report);
    }
    await d.write(() => d.store.setPr(runId, { ...pr, handled: key }));
    return status;
  }

  // A run whose user asked for it ends once its pull request is merged: after its agent
  // has gone quiet, it is stopped, the run is marked terminated and its worktree goes.
  // The branch stays, and a worktree with uncommitted work is never forced: it is kept
  // and named, and the run is terminated all the same.
  async function terminateAfterMerge(run: Run, pr: PullRequest): Promise<void> {
    if (!(await d.write(() => d.store.getTerminateOnPrMerge(run.id)))) return;
    if (run.node.status === "running" || d.runtime.isAlive(sessionOf(run))) return;
    await d.write(() => d.store.updateNode(run.id, NODE_ID, { prStatus: "terminated" }));
    const { kept } = await cleanRun(d.data, run);
    await d.write(() => d.store.setPr(run.id, { ...pr, handled: kept.length ? `terminated; kept ${kept.join(", ")}` : "terminated" }));
    if (kept.length) report(new Error(`run ${run.id}: kept its worktree, which has uncommitted work`));
  }

  // Clashes already told, so each is told once per daemon.
  const warned = new Set<string>();

  // Tells the orchestrators of two workers whose branches would conflict, while one of
  // them still works, so it can sequence them or settle who changes the files.
  async function checkRadar(): Promise<void> {
    const runs = await d.write(() => d.store.listRuns().map((id) => d.store.loadRun(id)));
    const byId = new Map(runs.map((r) => [r.id, r]));
    const projects = new Set(runs.filter((r) => r.role === "worker" && r.orchestrator).map((r) => r.project));
    for (const project of projects) {
      for (const hit of await radar(runs.filter((r) => r.project === project))) {
        const key = `${hit.a}|${hit.b}|${hit.files.join(",")}`;
        if (warned.has(key)) continue;
        warned.add(key);
        const a = byId.get(hit.a)!, b = byId.get(hit.b)!;
        const label = (r: Run) => `${r.id}${r.name ? ` (${r.name})` : ""}, ${r.node.status === "running" ? "working" : "done"}`;
        const message = `Workers ${label(a)} and ${label(b)} both change ${hit.files.join(", ")}: their work will conflict when both merge. Have one wait for the other or leave those files to it.`;
        for (const session of new Set([a.orchestrator, b.orchestrator].filter((o): o is string => !!o))) {
          const target = session.slice(0, session.indexOf("-"));
          const id = await d.write(() => d.store.queueMessage(target, NODE_ID, message, "rivet"));
          if (id !== null) await deliverQueued(target).catch(report);
        }
      }
    }
  }

  let radarTimer: NodeJS.Timeout | undefined;
  function watchRadar(intervalMs: number): void {
    radarTimer = setInterval(() => { void checkRadar().catch(report); }, intervalMs);
    radarTimer.unref();
  }

  let watcher: NodeJS.Timeout | undefined;
  // Looks at every open pull request on a timer until shutdown.
  function watchPrs(intervalMs: number): void {
    watcher = setInterval(() => {
      void (async () => {
        for (const id of await d.write(() => d.store.listRuns())) await checkPr(id).catch(report);
      })();
    }, intervalMs);
    watcher.unref();
  }

  // Puts an escalated or failed worker back to work after the user fixed what blocked
  // it, then continues whatever was interrupted.
  async function resume(runId: string): Promise<void> {
    const run = await load(runId);
    if (run.role === "orchestrator") {
      if (d.runtime.isAlive(sessionOf(run))) return;
      if (run.node.status !== "running") await transition(runId, "running");
      const fresh = await load(runId);
      // It continues its own conversation, told to look first: the workers it started may
      // have finished or reported while it was away.
      if (await d.agents(fresh.node.agent).restoreCommand({ sessionId: sessionOf(fresh), workspace: fresh.node.worktree, ...(fresh.node.agentSessionId ? { capturedId: fresh.node.agentSessionId } : {}) })) {
        await launch(fresh, RESTART_NOTE, { resume: true });
        return;
      }
      // No saved conversation: it starts again with the same note. The test fake's prompt
      // is its script, so it gets no note.
      const prompt = fresh.node.agent === "fake" ? orchestratorPrompt(fresh) : [RESTART_NOTE, "", orchestratorPrompt(fresh)].join("\n");
      await launch(fresh, prompt);
      return;
    }
    if (run.node.status === "escalated" || run.node.status === "failed" || run.node.status === "pending") {
      await runSession(runId, run.node.summary).catch(report);
      return;
    }
    await recover(runId);
  }

  // The user stops a session for good: a worker waits for resume, an orchestrator is over.
  // Neither comes back on its own when the daemon restarts.
  async function stopRun(runId: string): Promise<void> {
    const run = await load(runId);
    await stopSession(sessionOf(run));
    if (run.node.status !== "running") return;
    await transition(runId, run.role === "orchestrator" ? "done" : "escalated", "stopped by the user");
  }

  // After a daemon restart (or a resume): finish what was in flight. A session that never
  // started is left alone, and so is an orchestrator: it is someone you talk to, and a
  // fresh one could start the same work again, so it comes back only through resume.
  async function recover(runId: string): Promise<void> {
    const run = await load(runId);
    const node = run.node;
    if (node.id !== NODE_ID || node.status !== "running" || run.role !== "worker") return;
    if (node.finishedAt) {
      await track(workFinished(runId));
    } else if (!d.runtime.isAlive(sessionOf(run))) {
      const note = "Rivet was restarted while you worked; continue from the current state of the worktree.";
      await launch(run, workerPrompt(run, note)).catch(report);
    }
  }

  // Resolves once no check or pull request work is going on (tests and shutdown).
  async function idle(): Promise<void> {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  d.runtime.onExit((sessionId, launchId, code) => { void onExit(sessionId, launchId, code).catch(report); });

  return { launch, startRun, agentCheck, onReport, resume, stopRun, recover, idle, stopSession, shutdown, deliver: deliverQueued, publish, checkPr, watchPrs, checkRadar, watchRadar };
}

export type Scheduler = ReturnType<typeof createScheduler>;
