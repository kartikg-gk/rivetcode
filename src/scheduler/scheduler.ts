import { contextText } from "./conversations.js";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../git.js";
import type { Agent } from "../agents/agent.js";
import { abortMerge, commitLeftovers, finishResolution, headOf, mergeBranch, resetTo, runCommand, workingTree } from "../merge.js";
import { normalizePermission } from "../agents/command.js";
import { agentEnv, sessionIdOf } from "../runtime/env.js";
import { newLaunchId, type Runtime } from "../runtime/runtime.js";
import type { PullRequest, Run, Store } from "../store.js";
import { NODE_ID, setStatus, type Node, type Status } from "../model.js";
import { prStatus, type GitHub } from "../github/github.js";
import { handoffTurns } from "./prompts.js";
import { checkNote, ciFeedback, conflictPrompt, feedbackRules, orchestratorPrompt, partnerPrompt, reviewerPrompt, switchPrompt, reviewFeedback, workerPrompt } from "./prompts.js";
import { radar } from "./radar.js";
import { fromStream, readableOutput, type TimelineEntry } from "../timeline.js";
import { outsidePaths } from "./tasks.js";
import { conversationFile, runUsage } from "../usage.js";
import { cleanRun } from "./runs.js";
import { fileURLToPath } from "node:url";
import { encodeConfig, type Control } from "../chat/host.js";

// Agents edit files and run rivet and git on their own; a project can widen or narrow this.
export const DEFAULT_PERMISSION = "accept-edits";
// The agent's own id of the last reply: where a native fork of Claude's conversation is pinned.
function replyAnchor(items: { kind: string; itemId?: string }[]): { messageId?: string } {
  // Stored as "<host id>:<agent's id>"; a reply the agent gave no id has more parts.
  const parts = items.filter((i) => i.kind === "assistant").at(-1)?.itemId?.split(":") ?? [];
  return parts.length === 2 ? { messageId: parts[1]! } : {};
}

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

// A model name only means something to its own agent: "claude.model" and "codex.model"
// set each, and "worker.model" applies to the project's default agent only.
export function modelFor(agent: Node["agent"], config: Record<string, string>): string | undefined {
  const own = config[`${agent}.model`]?.trim();
  if (own) return own;
  return agent === (config["worker.agent"]?.trim() || "claude") ? config["worker.model"]?.trim() || undefined : undefined;
}

// What an orchestrator brought back by resume is told before anything else.
const RESTART_NOTE = "Rivet was restarted. Before starting anything, run rivet status: workers you started earlier may still be running or already done, so do not start the same work again.";

// How long a terminal agent gets to settle after Esc before more is typed.
const INTERRUPT_SETTLE_MS = 600;

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

  // A session's timeline. Codex run headless reports its work as JSON lines, read as they come.
  const note = (runId: string, session: string, entries: TimelineEntry[]) =>
    d.write(() => d.store.addTimeline(runId, session, entries)).catch(report);
  // Sessions whose JSON stream Rivet reads: their hooks add only prompts, or every call
  // and reply would be there twice.
  const streamed = new Set<string>();
  function followStream(runId: string, session: string, sessionId: string, agentName: string, headless: boolean): void {
    if (!headless || (agentName !== "codex" && agentName !== "claude")) {
      streamed.delete(sessionId);
      return;
    }
    streamed.add(sessionId);
    let partial = "";
    const toolNames = new Map<string, string>();
    d.runtime.attach(sessionId, (chunk) => {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop() ?? "";
      const entries = parts.flatMap((line) => fromStream(line, toolNames) ?? []);
      if (entries.length) void note(runId, session, entries);
    });
  }
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
  // Sessions run as chats (through the agent's protocol, see src/chat): messages and
  // answers go to them as control lines, and what they do comes from their host.
  const chats = new Set<string>();
  // Run from source (tests), the host is the built one.
  const chatHostMain = () => {
    const main = fileURLToPath(new URL("../cli/main.js", import.meta.url));
    return existsSync(main) ? main : fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
  };

  async function launch(run: Run, prompt?: string, o: { resume?: boolean; fresh?: boolean } = {}): Promise<string> {
    const node = run.node;
    const sessionId = sessionOf(run);
    if (d.runtime.isAlive(sessionId)) throw new SchedulerError(409, "session is already running");
    if (!existsSync(node.worktree)) throw new SchedulerError(409, `worktree is missing: ${node.worktree}`);
    const fork = await d.write(() => d.store.getFork(run.id));
    const branch = await d.write(() => d.store.activeBranch(run.id));
    if (fork?.detached) throw new SchedulerError(409, "fork was detached from its shared checkout");
    const agent = d.agents(node.agent);
    const launchId = newLaunchId();
    const config = await d.write(() => d.store.getConfig(run.project));
    const model = run.model ?? modelFor(node.agent, config);
    const allowedTools = (config["worker.allowedTools"] ?? DEFAULT_ALLOWED_TOOLS).split(",").map((t) => t.trim()).filter(Boolean);
    const worker = run.role === "worker";
    if (worker) {
      // The agent must be able to run what Rivet will judge its work by.
      for (const command of [run.spec?.doneWhen ?? config.check, config.test].map((c) => c?.trim()).filter((c): c is string => !!c)) {
        for (const rule of commandRules(command)) if (!allowedTools.includes(rule)) allowedTools.push(rule);
      }
      // A worker with a pull request may read its feedback itself (see checkPr).
      const pr = config["pr.feedback"] !== "full" ? await d.write(() => d.store.getPr(run.id)) : null;
      if (pr) for (const rule of feedbackRules(pr)) if (!allowedTools.includes(rule)) allowedTools.push(rule);
      const check = (run.spec?.doneWhen ?? config.check)?.trim();
      if (check && prompt !== undefined && node.agent !== "fake" && !o.resume) prompt += checkNote(check, config["verify.reuse"] !== "off");
    }
    // An orchestrator is someone you talk to, so it always gets a terminal (the test fake
    // has none). A worker runs headless unless the project asks for terminals.
    const chat = !run.spec?.terminal && (config["session.mode"] === "chat" || !!fork || !!branch) && (node.agent === "claude" || node.agent === "codex");
    if (chat && run.spec?.denyTools?.length) {
      const summary = "task denyTools cannot be enforced by this chat provider; use terminal mode or remove the unsupported restriction explicitly";
      await d.write(() => d.store.updateNode(run.id,NODE_ID,{status:"escalated",summary}));
      throw new SchedulerError(409,summary);
    }
    const headless = chat || (worker ? config["worker.mode"] !== "interactive" : node.agent === "fake");
    const cfg = {
      sessionId, workspace: node.worktree, headless,
      permission: normalizePermission(config["worker.permission"] ?? DEFAULT_PERMISSION),
      ...(model ? { model } : {}),
      ...(allowedTools.length ? { allowedTools } : {}),
      ...(run.spec?.denyTools?.length ? { disallowedTools: run.spec.denyTools } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    };
    if (chat && o.resume && !node.providerConversationId) throw new SchedulerError(409, `${run.id} has no conversation to resume`);
    const argv = chat
      ? [process.execPath, "--disable-warning=ExperimentalWarning", chatHostMain(), "chat-host", encodeConfig({
        inheritedTurns: (await d.write(() => d.store.inherited(run.id))).flatMap(i=>i.turnId ? [i.turnId] : []), agent: node.agent as "claude" | "codex", binary: agent.binary ?? node.agent, cwd: node.worktree, permission: cfg.permission, allow: allowedTools,
        ...(model ? { model } : {}), ...((o.resume || (fork && !o.fresh)) && node.providerConversationId ? { resume: node.providerConversationId } : {}), ...(fork && !o.fresh && !node.providerConversationId ? { fork: { providerId: fork.providerId, turn: fork.providerTurn, agent: fork.agent, ...replyAnchor(fork.items), context: contextText(fork.items, `Inherited context from ${fork.sourceRun} through position ${fork.position}.`) } } : {}), ...(branch && !node.providerConversationId ? { fork: { providerId: branch.items.at(-1)?.providerConversationId ?? "", turn: branch.items.at(-1)?.turnId, agent: branch.items.at(-1)?.agent ?? node.agent, ...replyAnchor(branch.items), context: contextText(branch.items, `Conversation branch ${branch.id} from run ${run.id}.`) } } : {}), ...(prompt !== undefined ? { prompt } : {}),
      })]
      : o.resume
        ? await agent.restoreCommand({ ...cfg, ...(node.agentSessionId ? { capturedId: node.agentSessionId } : {}) })
        : await agent.launchCommand(cfg);
    if (!argv) throw new SchedulerError(409, `${run.id} has no conversation to resume`);
    if (chat) chats.add(sessionId);
    else {
      chats.delete(sessionId);
      await agent.installHooks(node.worktree);
      await agent.prepare?.({ workspace: node.worktree, headless });
    }
    if ((node.sessionMode ?? "terminal") !== (chat ? "chat" : "terminal")) {
      await d.write(() => d.store.updateNode(run.id, node.id, { sessionMode: chat ? "chat" : "terminal" }));
    }
    // Recorded before the process exists, so even an instant exit is attributed to it.
    const previous = d.launches.get(sessionId);
    d.launches.set(sessionId, launchId);
    try {
      await d.runtime.start({
        sessionId, workspace: node.worktree, argv, launchId,
        ...(headless
          ? { stdin: chat || agent.acceptsInput({ headless: true }) ? "pipe" as const : "ignore" as const }
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
    // A chat's host records its own conversation.
    if (prompt !== undefined && !chat) await note(run.id, NODE_ID, [{ kind: o.resume ? "message" : "prompt", text: prompt }]);
    if (!chat) followStream(run.id, NODE_ID, sessionId, node.agent, headless);
    await d.write(() => d.store.markLaunched(run.id, node.id, !headless && !chat && agent.signals));
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
    if (queued.length === 0) return;
    // A headless agent gets its messages when its turn ends (see messagesAtTurnEnd).
    if (!d.runtime.takesInput(sessionId)) return;
    const activity = (await load(runId)).node.activity;
    // Typed into a permission question, a message would answer it: nothing goes in until
    // the question is answered (rivet answer).
    if (activity === "blocked") return;
    // A chat's host takes every message at once and keeps its mode: it steers the turn in
    // progress, waits for the next one, or stops the turn first.
    if (chats.has(sessionId)) {
      for (const m of queued) {
        const control: Control = { type: "send", mode: m.mode, text: m.message, messageId: m.id };
        try { await d.runtime.write(sessionId, JSON.stringify(control)); } catch { return; }
        // Chat delivery is acknowledged by a completed provider turn, not a pipe write.
      }
      return;
    }
    for (const m of queued) {
      // In order: a queued message waits for the agent to be idle, and so does what follows it.
      if (m.mode === "queue" && activity !== "idle" && activity !== "waiting_input") return;
      try {
        if (m.mode === "interrupt" && activity !== "idle" && activity !== "waiting_input") {
          d.runtime.input(sessionId, "\x1b");
          await new Promise((r) => setTimeout(r, INTERRUPT_SETTLE_MS));
        }
        await d.runtime.write(sessionId, m.message);
      } catch { return; }
      await d.write(() => d.store.markDelivered(m.id));
      await note(runId, NODE_ID, [{ kind: "message", text: m.message }]);
    }
  }

  // An interrupting message to a headless agent: its turn is stopped and its conversation
  // resumed with the message. Without a conversation to resume it waits like any other.
  async function interruptHeadless(runId: string): Promise<boolean> {
    const run = await load(runId);
    const session = sessionOf(run);
    if (!d.runtime.isAlive(session) || d.runtime.takesInput(session)) return false;
    const queued = await d.write(() => d.store.undeliveredMessages(runId, NODE_ID));
    if (!queued.some((m) => m.mode === "interrupt")) return false;
    const cfg = { sessionId: session, workspace: run.node.worktree, ...(run.node.agentSessionId ? { capturedId: run.node.agentSessionId } : {}) };
    if (!(await d.agents(run.node.agent).restoreCommand(cfg))) return false;
    await stopSession(session);
    return messagesAtTurnEnd(await load(runId));
  }

  // The permission question each terminal agent is stuck at, as its hook reported it.
  const pendingRequests = new Map<string, { tool: string; detail: string; at: string }>();
  function setPending(runId: string, request: { tool: string; detail: string } | null): void {
    if (request) pendingRequests.set(runId, { ...request, at: new Date().toISOString() });
    else pendingRequests.delete(runId);
  }

  // The keys each agent's permission question takes. Claude: checked live (1 runs it,
  // Esc refuses it). Codex: its documented keys; it could not be made to ask in a check.
  const ANSWER_KEYS: Record<string, Record<"yes" | "always" | "no", string>> = {
    claude: { yes: "1", always: "2", no: "\x1b" },
    codex: { yes: "y", always: "a", no: "\x1b" },
    fake: { yes: "y\r", always: "a\r", no: "n\r" },
  };

  // "rivet answer": answers the permission question a terminal agent waits at; a refusal
  // can carry what to do instead, typed in once the question is gone.
  async function answer(runId: string, choice: "yes" | "always" | "no", note?: string): Promise<void> {
    const run = await load(runId);
    const session = sessionOf(run);
    if (!d.runtime.isAlive(session)) throw new SchedulerError(409, `run ${runId} is not running`);
    if (run.node.activity !== "blocked") throw new SchedulerError(409, `run ${runId} is not waiting for a permission answer`);
    if (chats.has(session)) {
      const control: Control = { type: "answer", choice, ...(note?.trim() ? { note: note.trim() } : {}) };
      await d.runtime.write(session, JSON.stringify(control));
      setPending(runId, null);
      await d.write(() => d.store.setActivity(runId, NODE_ID, "active"));
      void deliverQueued(runId).catch(report);
      return;
    }
    const keys = ANSWER_KEYS[run.node.agent];
    if (!keys) throw new SchedulerError(409, `no answer keys for ${run.node.agent}`);
    try {
      d.runtime.input(session, keys[choice]);
    } catch {
      throw new SchedulerError(409, "only an agent in a terminal is asked for permission");
    }
    setPending(runId, null);
    await d.write(() => d.store.setActivity(runId, NODE_ID, "active"));
    if (choice === "no" && note?.trim()) {
      await new Promise((r) => setTimeout(r, INTERRUPT_SETTLE_MS));
      await d.runtime.write(session, note.trim());
    }
    void deliverQueued(runId).catch(report);
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
    // A task's own definition of done stands in for the project's check.
    const check = run.spec?.doneWhen ?? config.check;
    for (const [what, command, timeout] of [[run.spec?.doneWhen ? "done_when" : "check", check, checkTimeout], ["tests", config.test, testTimeout]] as const) {
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
    if (run.sharedWorkspace) {
      if (run.spec?.paths?.length) {
        const tracked = await filesChanged(run);
        const modified = await git(["diff","--name-only","HEAD"],run.node.worktree);
        const untracked = await git(["ls-files","--others","--exclude-standard"],run.node.worktree);
        const outside = outsidePaths([...tracked,...modified.split(/\r?\n/),...untracked.split(/\r?\n/)].filter(Boolean),run.spec.paths);
        if (outside.length) {await workFailed(runId,`shared checkout has changes outside allowed paths: ${outside.join(", ")}`);return;}
      }
      if (run.spec?.doneWhen) {
        const result = await verify(run);
        if (!result.ok) {await workFailed(runId,result.why);return;}
      }
      await d.write(() => d.store.updateNode(runId, NODE_ID, { finishedAt: new Date().toISOString() }));
      await transition(runId, "done", "fork exploration completed in shared checkout; use merge-back to transfer context");
      return;
    }
    await commitLeftovers(run.node.worktree, `rivet: save work left uncommitted by "${run.node.title}"`);
    // Any failure noted on an earlier attempt is over now.
    await d.write(() => d.store.updateNode(runId, NODE_ID, { finishedAt: new Date().toISOString(), summary: null }));
    const config = await d.write(() => d.store.getConfig(run.project));
    // A guardrail on paths: work that changed other files goes back.
    if (run.spec?.paths?.length) {
      const outside = outsidePaths(await filesChanged(run), run.spec.paths);
      if (outside.length) {
        await workFailed(runId, `it changed files outside the allowed paths (${run.spec.paths.join(", ")}): ${outside.join(", ")}. Undo those changes, or make them inside the allowed paths.`);
        return;
      }
    }
    const reused = config["verify.reuse"] !== "off" && passed.get(runId) === await workingTree(run.node.worktree);
    passed.delete(runId);
    if (!reused) {
      const result = await verify(run);
      if (!result.ok) {
        await workFailed(runId, result.why);
        return;
      }
    }
    // Work that changed nothing (the base already had it) is done, with no pull request to open.
    if (!(await hasChanges(run))) {
      await transition(runId, "done", `no changes: ${run.base} already has what the task asks for`);
      await tellOrchestrator(run, `Worker ${run.id}${run.name ? ` (${run.name})` : ""} finished with no changes: ${run.base} already has what it was asked for.`);
      return;
    }
    await transition(runId, "done");
    // Checked now as well as on the timer: its work may only now be committed.
    await checkRadar(runId).catch(report);
    await tellOrchestrator(run, `Worker ${run.id}${run.name ? ` (${run.name})` : ""} is done and its check passed.`);
    // A run with a pull request pushes every new result; "pr=auto" opens one the first time.
    const hasPr = (await d.write(() => d.store.getPr(runId))) !== null;
    if (d.github && (hasPr || config.pr === "auto")) await publish(runId).catch(report);
  }

  // Retry once, then hand it to the user.
  async function workFailed(runId: string, why: string): Promise<void> {
    const run = await load(runId);
    if (run.node.status !== "running") return;
    if (run.node.attempts < (run.spec?.attempts ?? MAX_ATTEMPTS)) {
      await transition(runId, "failed", why);
      await runSession(runId, why);
      return;
    }
    await transition(runId, "escalated", `gave up after ${run.node.attempts} attempts: ${why}`);
    await tellOrchestrator(run, `Worker ${run.id}${run.name ? ` (${run.name})` : ""} gave up: ${why.split(/\r?\n/)[0]}`);
  }

  // What an agent last printed, readable: Codex's JSON events become their text.
  function lastOutput(sessionId: string): string {
    return readableOutput(d.runtime.output(sessionId, OUTPUT_FOR_RETRY)?.lines ?? []).join("\n");
  }

  async function onExit(sessionId: string, launchId: string, code: number | null): Promise<void> {
    if (d.launches.get(sessionId) !== launchId) return;
    const waiter = exitWaiters.get(launchId);
    const runId = sessionId.slice(0, sessionId.indexOf("-"));
    if (sessionId === reviewSession(runId)) {
      await reviewerExited(runId);
      return;
    }
    if (sessionId === partnerSession(runId)) {
      await partnerExited(runId, code);
      return;
    }
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
    if (chats.has(sessionId) && code !== 0) {
      // The agent said why: that is the reason, not uncertainty.
      const failure = await d.write(() => d.store.lastTurnError(runId));
      if (failure) {
        await transition(runId, "escalated", `${run.node.agent} failed: ${failure}`);
        await tellOrchestrator(run, `Worker ${runId} stopped: ${run.node.agent} failed: ${failure}`);
        return;
      }
      await transition(runId, "escalated", "Chat completion is uncertain: inspect provider history and current files before an explicit resume; pending messages were preserved and were not automatically replayed.");
      await tellOrchestrator(run, `Worker ${runId} stopped with uncertain chat completion; inspect its history before resuming.`);
      return;
    }
    if (code === 0 || doneReported.has(sessionId)) {
      // Its partner is still at work: the worker's turn is not its finish. It is resumed
      // with the partner's result once that comes.
      if (partners.has(runId) && d.runtime.isAlive(partnerSession(runId))) {
        awaitingPartner.add(runId);
        return;
      }
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

  // A worker in a terminal stopped at a permission question: its orchestrator is told
  // once per question, since nothing goes on until someone answers.
  async function onBlocked(runId: string): Promise<void> {
    const run = await load(runId);
    if (run.role !== "worker" || !run.orchestrator) return;
    const session = sessionOf(run);
    const request = pendingRequests.get(runId);
    const shown = request ? "" : (d.runtime.output(session, 12)?.lines ?? []).join("\n").trim();
    await tellOrchestrator(run, [
      `Worker ${run.id}${run.name ? ` (${run.name})` : ""} is waiting for a permission answer and does nothing until it gets one.`,
      ...(request ? [`It asks to use ${request.tool}: ${request.detail}`] : shown ? ["Its screen ends with:", shown] : []),
      `Answer with: rivet answer ${run.id} yes|always|no [--note "<what to do instead>"]. Answer when it follows from the task; otherwise ask the user.`,
    ].join("\n"));
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
  async function onReport(runId: string, kind: string, said?: string): Promise<void> {
    const run = await load(runId);
    await note(runId, NODE_ID, [{ kind: "event", text: `reported ${kind}${said ? `: ${said}` : ""}` }]);
    await tellOrchestrator(run, `Worker ${run.id}${run.name ? ` (${run.name})` : ""} reports ${kind}${said ? `: ${said}` : ""}`);
    if (kind !== "done" || run.role !== "worker") return;
    const sessionId = sessionOf(run);
    doneReported.add(sessionId);
    if (d.runtime.isAlive(sessionId)) {
      if (chats.has(sessionId)) await d.runtime.write(sessionId, JSON.stringify({type:"finish"}));
      else await d.runtime.stop(sessionId);
    }
  }

  // A worker's chat turn failed and its agent is still up: nothing more will happen on its
  // own, so it stops and onExit escalates it with the agent's reason.
  async function chatTurnFailed(runId: string): Promise<void> {
    const run = await load(runId);
    const session = sessionOf(run);
    if (run.role === "worker" && chats.has(session) && !doneReported.has(session) && d.runtime.isAlive(session)) await d.runtime.stop(session);
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
    if (limitTimer) clearInterval(limitTimer);
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

  // Whether the worker's branch has commits its base does not.
  async function hasChanges(run: Run): Promise<boolean> {
    const count = await git(["rev-list", "--count", `${run.base}..HEAD`], run.node.worktree).catch(() => "1");
    return Number(count.trim()) > 0;
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
      ...(run.issue ? ["", `Closes #${run.issue}`] : []),
    ].join("\n");
  }

  // Brings the latest base into the finished work, tests again if it moved, pushes the
  // branch and opens the pull request if there is none yet. Never merges the PR.
  async function publish(runId: string): Promise<{ number: number; url: string }> {
    if (!d.github) throw new SchedulerError(409, "GitHub is not available");
    const run = await load(runId);
    const node = run.node;
    if (run.sharedWorkspace) throw new SchedulerError(409, "shared forks do not publish a second pull request; use the source run");
    if (run.role !== "worker") throw new SchedulerError(409, "only a worker opens a pull request");
    if (node.status !== "done") throw new SchedulerError(409, `run ${runId} is not done (it is ${node.status})`);
    if (!(await hasChanges(run))) throw new SchedulerError(409, `run ${runId} changed nothing, so there is no pull request to open`);
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
  const checkingPrs = new Map<string, Promise<string | null>>();
  function checkPr(runId: string): Promise<string | null> {
    if (shuttingDown) return Promise.resolve(null);
    const existing = checkingPrs.get(runId); if (existing) return existing;
    const work = track(checkPrOnce(runId)); checkingPrs.set(runId, work);
    void work.finally(() => { if (checkingPrs.get(runId) === work) checkingPrs.delete(runId); }).catch(() => {});
    return work;
  }
  async function checkPrOnce(runId: string): Promise<string | null> {
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
    if (shuttingDown) return null;
    const status = prStatus(facts);
    await d.write(() => d.store.updateNode(runId, NODE_ID, { prStatus: status }));
    if (status === "merged") {
      await terminateAfterMerge(await load(runId), pr);
      return status;
    }
    const key = `${status}:${facts.mergeability}:${facts.headSha}`;
    if (node.status === "done" && facts.open && (status === "pr_open" || status === "mergeable" || status === "approved" || status === "review_pending")) {
      await autoReview(run, facts.headSha).catch(report);
    }
    // Work is already under way, or this exact state was handled before.
    if (pr.handled === key || node.status !== "done") return status;
    // By default the worker is told where the feedback is and reads it itself; "full" has
    // Rivet fetch it and hand it over.
    const full = (await d.write(() => d.store.getConfig(run.project)))["pr.feedback"] === "full";
    if (status === "ci_failed") {
      await reopen(runId, ciFeedback(pr, full ? await github.failedPaths(pr.number) : undefined));
    } else if (status === "changes_requested") {
      await reopen(runId, reviewFeedback(pr, full ? await github.reviewComments(pr.number) : undefined));
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
    const { kept } = await cleanWorkspace(run);
    await d.write(() => d.store.setPr(run.id, { ...pr, handled: kept.length ? `terminated; kept ${kept.join(", ")}` : "terminated" }));
    if (kept.length) report(new Error(`run ${run.id}: kept its worktree, which has uncommitted work`));
  }

  // Clashes already told, so each is told once per daemon.
  const warned = new Set<string>();

  // Tells the orchestrators of two workers whose branches would conflict, while one of
  // them still works, so it can sequence them or settle who changes the files.
  async function checkRadar(focus?: string): Promise<void> {
    const runs = await d.write(() => d.store.listRuns().map((id) => d.store.loadRun(id)));
    const byId = new Map(runs.map((r) => [r.id, r]));
    const projects = new Set(runs.filter((r) => r.role === "worker" && r.orchestrator).map((r) => r.project));
    for (const project of projects) {
      for (const hit of await radar(runs.filter((r) => r.project === project), focus)) {
        const key = `${hit.a}|${hit.b}|${hit.files.join(",")}`;
        if (warned.has(key)) continue;
        warned.add(key);
        const a = byId.get(hit.a)!, b = byId.get(hit.b)!;
        const label = (r: Run) => `${r.id}${r.name ? ` (${r.name})` : ""}, ${r.node.status === "running" ? "working" : "done"}`;
        const working = a.node.status === "running" || b.node.status === "running";
        const message = `Workers ${label(a)} and ${label(b)} both change ${hit.files.join(", ")}: their work will conflict when both merge. ${working
          ? "Have one wait for the other or leave those files to it."
          : "Once one is merged, Rivet brings the other up to date and its worker resolves the conflict."}`;
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

  // --- Reviewer: a second agent reviews a worker's pull request in the worker's worktree,
  // read-only. Rivet posts its review and sends the changes it requires to the worker.

  const reviewSession = (runId: string) => sessionIdOf(runId, "review");
  // Commands a reviewer may run: reading the code and its history, and submitting.
  const REVIEWER_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)", "Bash(rivet review submit:*)"];
  // Failed automatic passes on one commit before Rivet stops trying it.
  const REVIEW_TRIES = 3;

  // sha: the pull request's head as GitHub reports it (automatic passes are counted by it);
  // by hand, the worktree's head.
  async function startReview(runId: string, trigger: "auto" | "manual", headSha?: string): Promise<number> {
    const run = await load(runId);
    if (run.role !== "worker") throw new SchedulerError(409, "only a worker's pull request is reviewed");
    if (run.node.status !== "done") throw new SchedulerError(409, `run ${runId} is not done (it is ${run.node.status})`);
    const pr = await d.write(() => d.store.getPr(runId));
    if (!pr) throw new SchedulerError(409, `run ${runId} has no pull request to review`);
    const session = reviewSession(runId);
    if (d.runtime.isAlive(session)) throw new SchedulerError(409, "a review is already running");
    const sha = headSha ?? await headOf(run.node.worktree);
    const config = await d.write(() => d.store.getConfig(run.project));
    const agentName = (config["review.agent"]?.trim() || run.node.agent) as Node["agent"];
    const agent = d.agents(agentName);
    const id = await d.write(() => d.store.startReview(runId, sha, trigger));
    const launchId = newLaunchId();
    const argv = await agent.launchCommand({
      sessionId: session, workspace: run.node.worktree, headless: true, permission: "read-only",
      allowedTools: REVIEWER_TOOLS, prompt: reviewerPrompt(run, pr, sha),
      ...(modelFor(agentName, config) ? { model: modelFor(agentName, config)! } : {}),
    });
    d.launches.set(session, launchId);
    try {
      await d.runtime.start({
        sessionId: session, workspace: run.node.worktree, argv, launchId, stdin: "ignore",
        env: agentEnv({ runId, nodeId: "review", project: run.project, dataDir: d.data, runFile: d.runFile, launchId }),
      });
      await note(runId, "review", [{ kind: "prompt", text: reviewerPrompt(run, pr, sha) }]);
      followStream(runId, "review", session, agentName, true);
    } catch (e) {
      await d.write(() => d.store.endReview(id, { status: "failed", body: `could not start: ${(e as Error).message}` }));
      throw e;
    }
    return id;
  }

  // A reviewer that exits without submitting has failed that pass.
  async function reviewerExited(runId: string): Promise<void> {
    const running = (await d.write(() => d.store.reviewsOf(runId))).filter((r) => r.status === "running");
    for (const r of running) {
      await d.write(() => d.store.endReview(r.id, { status: "failed", body: `the reviewer exited without submitting\n${lastOutput(reviewSession(runId))}` }));
    }
  }

  // "rivet review submit" from the reviewer. Required changes go to the worker first, so
  // the pull request watcher finds it at work and does not act on the same comments.
  async function submitReview(runId: string, o: { verdict: "approved" | "changes_requested"; summary: string; comments: { path: string; line: number; body: string }[] }): Promise<{ githubReviewId?: number }> {
    const run = await load(runId);
    const review = (await d.write(() => d.store.reviewsOf(runId))).filter((r) => r.status === "running").at(-1);
    if (!review) throw new SchedulerError(409, "no review of this run is running");
    if (o.verdict === "changes_requested" && o.comments.length === 0) throw new SchedulerError(400, "changes_requested needs at least one --comment");
    const pr = (await d.write(() => d.store.getPr(runId)))!;
    const body = [`Review by ${run.node.agent === "fake" ? "a reviewer" : "Rivet's reviewer"}: ${o.verdict === "approved" ? "ready" : "changes requested"}.`, "", o.summary].join("\n");
    if (o.verdict === "changes_requested" && run.node.status === "done") {
      await reopen(runId, [
        `A reviewer asked for changes on pull request #${pr.number}. Make each one:`,
        ...o.comments.map((c) => `- ${c.path}:${c.line}: ${c.body}`),
      ].join("\n"));
    }
    let githubReviewId: number | undefined;
    if (d.github) {
      githubReviewId = await (await d.github(run)).postReview(pr.number, { commitId: review.sha, body, comments: o.comments })
        .catch((e) => { report(e); return undefined; });
    }
    await d.write(() => d.store.endReview(review.id, { status: "complete", verdict: o.verdict, body, ...(githubReviewId ? { githubReviewId } : {}) }));
    if (o.verdict === "approved") await tellOrchestrator(run, `Worker ${run.id}${run.name ? ` (${run.name})` : ""}: its pull request #${pr.number} passed review.`);
    void stopSession(reviewSession(runId)).catch(report);
    return githubReviewId ? { githubReviewId } : {};
  }

  // With review=auto, a worker's pull request is reviewed once per commit, after the
  // worker is done and while nothing else is asked of it.
  async function autoReview(run: Run, sha: string): Promise<void> {
    const config = await d.write(() => d.store.getConfig(run.project));
    if (config.review !== "auto" || d.runtime.isAlive(reviewSession(run.id))) return;
    const passes = (await d.write(() => d.store.reviewsOf(run.id))).filter((r) => r.sha === sha);
    if (passes.some((r) => r.status !== "failed")) return;
    if (passes.filter((r) => r.trigger === "auto").length >= REVIEW_TRIES) return;
    await startReview(run.id, "auto", sha);
  }

  // --- Delegation: a worker hands part of its task (or a review of its changes) to a
  // partner agent in its own worktree. The partner gets only that task, never commits, and
  // its result comes back to the worker as a message.

  const partnerSession = (runId: string) => sessionIdOf(runId, "partner");
  // The partner of each worker while it works: its agent, whether it reviews, its report.
  const partners = new Map<string, { agent: Node["agent"]; review: boolean; note?: string }>();
  // Workers whose turn ended while their partner worked; they go on when it is done.
  const awaitingPartner = new Set<string>();
  const PARTNER_REVIEW_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)", "Bash(rivet report:*)"];

  async function delegate(runId: string, o: { task: string; agent?: Node["agent"]; model?: string; review?: boolean }): Promise<{ session: string; agent: Node["agent"] }> {
    const run = await load(runId);
    if (run.role !== "worker") throw new SchedulerError(409, "only a worker delegates");
    if (run.node.status !== "running") throw new SchedulerError(409, `run ${runId} is not working (it is ${run.node.status})`);
    const session = partnerSession(runId);
    if (d.runtime.isAlive(session)) throw new SchedulerError(409, "this worker already has a partner at work; wait for its result");
    if (!o.review && !o.task.trim()) throw new SchedulerError(400, "delegate needs a task");
    const config = await d.write(() => d.store.getConfig(run.project));
    const agentName = o.agent ?? run.node.agent;
    const agent = d.agents(agentName);
    const model = o.model ?? modelFor(agentName, config);
    const allowedTools = (config["worker.allowedTools"] ?? DEFAULT_ALLOWED_TOOLS).split(",").map((t) => t.trim()).filter(Boolean);
    const launchId = newLaunchId();
    const argv = await agent.launchCommand({
      sessionId: session, workspace: run.node.worktree, headless: true,
      permission: o.review ? "read-only" : normalizePermission(config["worker.permission"] ?? DEFAULT_PERMISSION),
      allowedTools: o.review ? PARTNER_REVIEW_TOOLS : allowedTools,
      prompt: partnerPrompt(run, o.task, !!o.review, agentName),
      ...(model ? { model } : {}),
    });
    partners.set(runId, { agent: agentName, review: !!o.review });
    d.launches.set(session, launchId);
    try {
      await d.runtime.start({
        sessionId: session, workspace: run.node.worktree, argv, launchId, stdin: "ignore",
        env: agentEnv({ runId, nodeId: "partner", project: run.project, dataDir: d.data, runFile: d.runFile, launchId }),
      });
      await note(runId, "partner", [{ kind: "prompt", text: partnerPrompt(run, o.task, !!o.review, agentName) }]);
      followStream(runId, "partner", session, agentName, true);
    } catch (e) {
      partners.delete(runId);
      throw e;
    }
    return { session, agent: agentName };
  }

  // "rivet report" from a partner: its note is its result.
  function partnerReport(runId: string, kind: string, note?: string): void {
    const partner = partners.get(runId);
    if (partner && note) partner.note = `${kind === "done" ? "" : `(${kind}) `}${note}`;
  }

  // The partner's result goes to the worker that delegated, as a message.
  async function partnerExited(runId: string, code: number | null): Promise<void> {
    const partner = partners.get(runId);
    partners.delete(runId);
    if (!partner) return;
    const what = partner.review ? "review of your changes" : "delegated task";
    const result = partner.note ?? (lastOutput(partnerSession(runId)).trim() || `it exited with code ${code} and reported nothing`);
    const message = `Your partner (${partner.agent}) finished the ${what}${code === 0 || partner.note ? "" : " with an error"}:\n${result}`;
    const id = await d.write(() => d.store.queueMessage(runId, NODE_ID, message, partnerSession(runId)));
    if (id !== null) await deliverQueued(runId).catch(report);
    if (awaitingPartner.delete(runId)) {
      const run = await load(runId);
      if (run.node.status !== "running" || d.runtime.isAlive(sessionOf(run))) return;
      // Resumed with the result; without a conversation to resume, its work is taken as is.
      if (!(await messagesAtTurnEnd(run))) await track(workFinished(runId));
    }
  }

  // --- Limits from a task file: a worker past its time or token budget is stopped and
  // escalated with the reason.
  async function checkLimits(now = Date.now()): Promise<void> {
    const runs = await d.write(() => d.store.listRuns().map((id) => d.store.loadRun(id))
      .filter((r) => r.role === "worker" && r.node.status === "running" && (r.spec?.minutes || r.spec?.tokens)));
    for (const run of runs) {
      let why: string | undefined;
      if (run.spec!.minutes && run.node.startedAt && now - Date.parse(run.node.startedAt) > run.spec!.minutes * 60_000) {
        why = `it reached its time limit of ${run.spec!.minutes} minutes`;
      } else if (run.spec!.tokens) {
        const used = runUsage(await d.write(() => d.store.conversations(run.id))).inputEquivalent;
        if (used > run.spec!.tokens) why = `it used ${used} input-equivalent tokens, over its limit of ${run.spec!.tokens}`;
      }
      if (!why) continue;
      await stopSession(sessionOf(run));
      await transition(run.id, "escalated", `stopped: ${why}`).catch(report);
      await tellOrchestrator(run, `Worker ${run.id}${run.name ? ` (${run.name})` : ""} was stopped: ${why}.`);
    }
  }

  let limitTimer: NodeJS.Timeout | undefined;
  function watchLimits(intervalMs: number): void {
    limitTimer = setInterval(() => { void checkLimits().catch(report); }, intervalMs);
    limitTimer.unref();
  }

  // --- Switching a worker to another agent: the running one stops, the new one starts in
  // the same worktree, branch and pull request with a handoff of where things are.
  // A switch waits this long for the agent to finish its turn (unless told to cut it short).
  const SWITCH_WAIT_MS = 100_000;

  async function switchAgent(runId: string, to: Node["agent"], model?: string, now = false, waitMs = SWITCH_WAIT_MS): Promise<void> {
    let run = await load(runId);
    if (run.role !== "worker") throw new SchedulerError(409, "only a worker's agent is switched");
    if (run.node.status === "done" || run.node.status === "pending") throw new SchedulerError(409, `run ${runId} is ${run.node.status}; switch a worker that is working, failed or escalated`);
    if (to === run.node.agent && !model) throw new SchedulerError(409, `run ${runId} already runs ${to}`);
    // Switch agents between turns: stopping mid-turn can leave a git lock,
    // a half-done merge or a half-installed package behind.
    const busy = () => d.runtime.isAlive(sessionOf(run)) && (run.node.activity === "active" || run.node.activity === "blocked");
    for (const end = Date.now() + waitMs; !now && busy(); run = await load(runId)) {
      if (Date.now() > end) throw new SchedulerError(409, `run ${runId} is still working; switch again when it is idle, or with --now to stop it mid-turn`);
      await new Promise((r) => setTimeout(r, 500));
    }
    // It may have finished its task while the switch waited.
    if (doneReported.has(sessionOf(run)) || run.node.status === "done") throw new SchedulerError(409, `run ${runId} finished its task; nothing to switch`);
    const notes: string[] = [];
    if (d.runtime.isAlive(partnerSession(runId))) {
      await stopSession(partnerSession(runId));
      notes.push("An agent it had delegated part of the work to was stopped; that part may be unfinished.");
    }
    partners.delete(runId);
    awaitingPartner.delete(runId);
    setPending(runId, null);
    const from = run.node.agent;
    const conversation = run.node.agentSessionId ? conversationFile(from, run.node.agentSessionId) : null;
    // A chat's whole conversation is Rivet's own record, readable with rivet read.
    const history = run.node.sessionMode === "chat" ? `rivet read ${runId} --activity` : null;
    await stopSession(sessionOf(run));
    const log = await git(["log", "--oneline", `${run.base}..HEAD`], run.node.worktree).catch(() => "");
    const status = await git(["status", "--short"], run.node.worktree).catch(() => "");
    const otherWriters = await d.write(() => d.store.listRuns().map((id) => d.store.loadRun(id)).some((r) => r.id !== runId && r.node.worktree === run.node.worktree && d.runtime.isAlive(sessionOf(r))));
    notes.push(...await settleGit(run.node.worktree, !otherWriters));
    const said = await d.write(() => (run.node.sessionMode === "chat" ? d.store.readChat : d.store.readTimeline)(runId, { limit: 10_000, kinds: ["prompt", "message", "assistant"], session: NODE_ID }));
    const turns = handoffTurns(said.items, from);
    await d.write(() => {
      d.store.updateNode(runId, NODE_ID, { agent: to, agentSessionId: null });
      const fresh = d.store.loadRun(runId);
      const { model: _old, ...rest } = fresh;
      d.store.saveRun(model ? { ...rest, model } : rest);
    });
    if (run.node.status !== "running") await transition(runId, "running");
    const switched = await load(runId);
    await launch(switched, switchPrompt(switched, { agent: from, conversation: history ? null : conversation, history, log, status, notes, turns }), { fresh: true });
    await tellOrchestrator(switched, `Worker ${runId}${run.name ? ` (${run.name})` : ""} switched from ${from} to ${to}.`);
  }

  // After an agent is stopped: a lock its git left is removed (no one holds it now), and a
  // merge or rebase it left half done is named for the next agent.
  async function settleGit(worktree: string, removeLock = true): Promise<string[]> {
    const dir = (await git(["rev-parse", "--absolute-git-dir"], worktree).catch(() => "")).trim();
    if (!dir) return [];
    const notes: string[] = [];
    if (!removeLock && existsSync(join(dir, "index.lock"))) notes.push("Another live session shares the checkout; its git lock was left in place.");
    if (removeLock && existsSync(join(dir, "index.lock"))) {
      await rm(join(dir, "index.lock"), { force: true });
      notes.push("Its git was stopped mid-command; the lock it left was removed.");
    }
    if (existsSync(join(dir, "MERGE_HEAD"))) notes.push("A merge is in progress (git status shows it): finish or abort it first.");
    if (existsSync(join(dir, "rebase-merge")) || existsSync(join(dir, "rebase-apply"))) notes.push("A rebase is in progress: finish it (git rebase --continue) or abort it first.");
    return notes;
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
    if (run.sharedWorkspace) { await startForkMessage(runId); return; }
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
    if (run.node.agent !== "fake" && !d.runtime.isAlive(sessionOf(run)) && (run.node.providerConversationId || run.node.agentSessionId)) {
      if (run.node.status !== "running") await transition(runId, "running");
      await d.write(() => d.store.updateNode(runId, NODE_ID, {finishedAt:null}));
      await launch(await load(runId), "The user explicitly resumed this interrupted work. Inspect current files and provider history before repeating any possibly completed action.", {resume:true});
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
  // Stopping an orchestrator also stops the workers it started that are still working,
  // unless keepWorkers: their work was its plan, and a new orchestrator would not know them.
  async function stopRun(runId: string, o: { keepWorkers?: boolean } = {}): Promise<string[]> {
    const run = await load(runId);
    await stopSession(sessionOf(run));
    if (run.node.status === "running") {
      await transition(runId, run.role === "orchestrator" ? "done" : "escalated", "stopped by the user");
    }
    if (run.role !== "orchestrator" || o.keepWorkers) return [];
    const session = sessionOf(run);
    const workers = await d.write(() => d.store.listRuns().map((id) => d.store.loadRun(id))
      .filter((r) => r.orchestrator === session && r.node.status === "running"));
    for (const w of workers) {
      await stopSession(sessionOf(w));
      await transition(w.id, "escalated", `stopped with its orchestrator ${run.id}`).catch(report);
    }
    return workers.map((w) => w.id);
  }

  // After a daemon restart (or a resume): finish what was in flight. A session that never
  // started is left alone, and so is an orchestrator: it is someone you talk to, and a
  // fresh one could start the same work again, so it comes back only through resume.
  async function recover(runId: string): Promise<void> {
    const run = await load(runId);
    const node = run.node;
    if (run.sharedWorkspace) return;
    if (node.id !== NODE_ID || node.status !== "running" || run.role !== "worker") return;
    if (node.finishedAt) {
      await track(workFinished(runId));
    } else if (!d.runtime.isAlive(sessionOf(run))) {
      if (node.agent !== "fake") {
        await transition(runId, "escalated", "Interrupted by daemon restart; delivery may be uncertain. Inspect current files and history, then explicitly resume. No pending instruction was automatically replayed.");
        return;
      }
      const note = "Rivet was restarted while you worked; continue from the current state of the worktree.";
      await launch(run, workerPrompt(run, note)).catch(report);
    }
  }

  // Resolves once no check or pull request work is going on (tests and shutdown).
  async function idle(): Promise<void> {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  d.runtime.onExit((sessionId, launchId, code) => { void onExit(sessionId, launchId, code).catch(report); });

  const cleaningWorkspaces = new Set<string>();
  async function cleanWorkspace(run: Run): Promise<{ removed: string[]; kept: string[] }> {
    if (run.sharedWorkspace) return { removed: [], kept: [NODE_ID] };
    const preserve = await d.write(() => {
      if (cleaningWorkspaces.has(run.node.worktree)) throw new SchedulerError(409, "checkout is already being cleaned");
      if (d.store.workspaceForks(run.id).length) return true;
      cleaningWorkspaces.add(run.node.worktree);
      return false;
    });
    if (preserve) return { removed: [], kept: [NODE_ID] };
    try { return await cleanRun(d.data, run); } finally { cleaningWorkspaces.delete(run.node.worktree); }
  }
  const startingForks = new Map<string, Promise<void>>();
  async function startForkMessage(runId: string): Promise<boolean> {
    const run = await load(runId);
    if (!run.sharedWorkspace || d.runtime.isAlive(sessionOf(run))) return false;
    if ((await d.write(() => d.store.getFork(runId)))?.detached) throw new SchedulerError(409, "fork was detached from its shared checkout");
    if (startingForks.has(runId)) { await startingForks.get(runId); return true; }
    const work = (async () => {
      if ((await load(runId)).node.status !== "running") await transition(runId, "running");
      await d.write(() => d.store.updateNode(runId, NODE_ID, { finishedAt: null }));
      await launch(await load(runId));
    })();
    startingForks.set(runId, work);
    try { await work; return true; } finally { startingForks.delete(runId); }
  }

  return { chatTurnFailed, cleanWorkspace, isCleaning: (path: string) => cleaningWorkspaces.has(path), startForkMessage, launch, isChat: (sessionId: string) => chats.has(sessionId), streamsTimeline: (sessionId: string) => streamed.has(sessionId), startRun, onBlocked, answer, setPending, pendingRequest: (runId: string) => pendingRequests.get(runId) ?? null, interruptHeadless, agentCheck, startReview, submitReview, delegate, partnerReport, onReport, resume, stopRun, recover, idle, stopSession, shutdown, deliver: deliverQueued, publish, checkPr, watchPrs, checkRadar, watchRadar, checkLimits, watchLimits, switchAgent };
}

export type Scheduler = ReturnType<typeof createScheduler>;
