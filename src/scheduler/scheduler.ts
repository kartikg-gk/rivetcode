import { existsSync } from "node:fs";
import { git } from "../git.js";
import type { Agent } from "../agents/agent.js";
import {
  abortMerge, commitLeftovers, finishResolution, headOf, mergeBranch, mergeInProgress, resetTo, runCommand,
} from "../merge.js";
import { normalizePermission } from "../agents/command.js";
import { agentEnv, sessionIdOf } from "../runtime/env.js";
import { newLaunchId, type Runtime } from "../runtime/runtime.js";
import type { Run, Store } from "../store.js";
import { setStatus, type Node, type Status } from "../tree.js";
import { conflictPrompt, leafPrompt } from "./prompts.js";

// Agents run without a terminal for now, so they need leave to edit files and to run
// rivet and git on their own; a project can widen or narrow this.
export const DEFAULT_PERMISSION = "accept-edits";
export const DEFAULT_ALLOWED_TOOLS = "Bash(rivet:*),Bash(git:*)";

// A leaf gets this many launches before Rivet stops retrying and asks the user.
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
  // Called with every problem the scheduler could not handle itself (for logs and tests).
  onError?(error: unknown): void;
};

export class SchedulerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SchedulerError";
  }
}

const FINAL_RUN: Status[] = ["done", "failed", "escalated", "skipped"];

// Drives runs: starts leaves, merges each finished child into its parent as soon as it
// is done (one merge at a time per parent), checks every merge, retries a failing leaf
// once, and escalates to the user what it cannot fix.
export function createScheduler(d: SchedulerDeps) {
  const checkTimeout = d.checkTimeoutMs ?? 10 * 60_000;
  const testTimeout = d.testTimeoutMs ?? 30 * 60_000;
  const merges = new Map<string, Promise<void>>();
  const exitWaiters = new Map<string, (code: number | null) => void>();
  const doneReported = new Set<string>();
  // Sessions stopped on purpose (by the user or a shutdown): their exit is not a failure.
  const stoppedOnPurpose = new Set<string>();
  let shuttingDown = false;
  const report = (e: unknown) => d.onError?.(e);

  const load = (runId: string) => d.write(() => d.store.loadRun(runId));

  // Validated status change on fresh state; touches only that node's status fields.
  function transition(runId: string, nodeId: string, to: Status, summary?: string): Promise<Node> {
    return d.write(() => {
      const run = d.store.loadRun(runId);
      const node = setStatus(run.nodes, nodeId, to, summary).find((n) => n.id === nodeId)!;
      d.store.updateNode(runId, nodeId, {
        status: node.status, attempts: node.attempts, ...(summary !== undefined ? { summary } : {}),
      });
      return node;
    });
  }

  const nodeOf = (run: Run, id: string) => {
    const n = run.nodes.find((x) => x.id === id);
    if (!n) throw new SchedulerError(404, `unknown node ${id}`);
    return n;
  };
  const childrenOf = (run: Run, id: string) => run.nodes.filter((n) => n.parentId === id);

  async function launch(run: Run, node: Node, prompt?: string): Promise<string> {
    const sessionId = sessionIdOf(run.id, node.id);
    if (d.runtime.isAlive(sessionId)) throw new SchedulerError(409, "session is already running");
    if (!existsSync(node.worktree)) throw new SchedulerError(409, `worktree is missing: ${node.worktree}`);
    const agent = d.agents(node.agent);
    const launchId = newLaunchId();
    const config = await d.write(() => d.store.getConfig(run.project));
    const model = config["worker.model"]?.trim();
    const allowedTools = (config["worker.allowedTools"] ?? DEFAULT_ALLOWED_TOOLS).split(",").map((t) => t.trim()).filter(Boolean);
    const argv = await agent.launchCommand({
      sessionId, workspace: node.worktree, headless: true,
      permission: normalizePermission(config["worker.permission"] ?? DEFAULT_PERMISSION),
      ...(model ? { model } : {}),
      ...(allowedTools.length ? { allowedTools } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    });
    await agent.installHooks(node.worktree);
    // Recorded before the process exists, so even an instant exit is attributed to it.
    const previous = d.launches.get(sessionId);
    d.launches.set(sessionId, launchId);
    try {
      await d.runtime.start({
        sessionId, workspace: node.worktree, argv, launchId,
        stdin: agent.acceptsInput({ headless: true }) ? "pipe" : "ignore",
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
    await d.write(() => d.store.setActivity(run.id, node.id, "active"));
    await deliverQueued(run.id, node.id);
    return launchId;
  }

  // One delivery pass per session at a time, so two sends never type a message twice.
  const delivering = new Map<string, Promise<void>>();
  function deliverQueued(runId: string, nodeId: string): Promise<void> {
    const sessionId = sessionIdOf(runId, nodeId);
    const next = (delivering.get(sessionId) ?? Promise.resolve()).then(() => deliverNow(runId, nodeId));
    const tail = next.catch(() => {});
    delivering.set(sessionId, tail);
    void tail.then(() => { if (delivering.get(sessionId) === tail) delivering.delete(sessionId); });
    return next;
  }

  async function deliverNow(runId: string, nodeId: string): Promise<void> {
    const sessionId = sessionIdOf(runId, nodeId);
    const pending = await d.write(() => d.store.undeliveredMessages(runId, nodeId));
    for (const m of pending) {
      if (!d.runtime.isAlive(sessionId)) return;
      try { await d.runtime.write(sessionId, m.message); } catch { return; }
      await d.write(() => d.store.markDelivered(m.id));
    }
  }

  // Starts (or restarts) a leaf: counts an attempt and launches its agent.
  async function runLeaf(runId: string, nodeId: string, retry?: string): Promise<void> {
    const node = await transition(runId, nodeId, "running");
    const run = await load(runId);
    await d.write(() => d.store.updateNode(runId, nodeId, { finishedAt: null }));
    await launch(run, node, leafPrompt(run, node, retry));
  }

  async function startRun(runId: string): Promise<void> {
    const run = await load(runId);
    if (run.nodes.some((n) => n.status !== "pending")) throw new SchedulerError(409, `run ${runId} has already started`);
    for (const p of run.nodes.filter((n) => n.kind === "parent")) await transition(runId, p.id, "waiting");
    for (const leaf of run.nodes.filter((n) => n.kind === "leaf")) {
      await runLeaf(runId, leaf.id).catch(async (e) => {
        await transition(runId, leaf.id, "escalated", `could not start: ${(e as Error).message}`).catch(report);
        report(e);
      });
    }
  }

  // A leaf's work is over: save leftovers, mark it finished, hand it to its parent.
  async function leafFinished(runId: string, nodeId: string): Promise<void> {
    const run = await load(runId);
    const node = nodeOf(run, nodeId);
    if (node.status !== "running" || node.finishedAt) return;
    await commitLeftovers(node.worktree, `rivet: save work left uncommitted by "${node.title}"`);
    await d.write(() => d.store.updateNode(runId, nodeId, { finishedAt: new Date().toISOString() }));
    if (node.parentId === null) {
      // A single-leaf run: the leaf is the root, nothing to merge into.
      await completeRoot(runId);
      return;
    }
    enqueueMerge(runId, node.parentId, nodeId);
  }

  async function leafFailed(runId: string, nodeId: string, why: string): Promise<void> {
    const run = await load(runId);
    const node = nodeOf(run, nodeId);
    if (node.status !== "running") return;
    if (node.attempts < MAX_ATTEMPTS) {
      await transition(runId, nodeId, "failed", why);
      await runLeaf(runId, nodeId, why);
    } else {
      await transition(runId, nodeId, "escalated", `gave up after ${node.attempts} attempts: ${why}`);
    }
  }

  function lastOutput(sessionId: string): string {
    return (d.runtime.output(sessionId, OUTPUT_FOR_RETRY)?.lines ?? []).join("\n");
  }

  async function onExit(sessionId: string, launchId: string, code: number | null): Promise<void> {
    if (d.launches.get(sessionId) !== launchId) return;
    const waiter = exitWaiters.get(launchId);
    const split = sessionId.indexOf("-");
    const runId = sessionId.slice(0, split);
    const nodeId = sessionId.slice(split + 1);
    await d.write(() => d.store.setActivity(runId, nodeId, "exited"));
    if (waiter) {
      exitWaiters.delete(launchId);
      waiter(code);
      return;
    }
    if (shuttingDown) return;
    if (stoppedOnPurpose.delete(sessionId) && !doneReported.has(sessionId)) return;
    let run: Run;
    try { run = await load(runId); } catch { return; }
    const node = run.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== "leaf") return;
    if (code === 0 || doneReported.has(sessionId)) await leafFinished(runId, nodeId);
    else await leafFailed(runId, nodeId, `agent exited with code ${code}\n${lastOutput(sessionId)}`);
  }

  // "rivet report --done": the agent says it is finished; stop it and take the work.
  async function onReport(runId: string, nodeId: string, kind: string): Promise<void> {
    if (kind !== "done") return;
    const sessionId = sessionIdOf(runId, nodeId);
    doneReported.add(sessionId);
    if (d.runtime.isAlive(sessionId)) await d.runtime.stop(sessionId);
  }

  // Stops an agent without treating its exit as a failure; resume or a restart relaunches it.
  async function stopSession(sessionId: string): Promise<void> {
    if (!d.runtime.isAlive(sessionId)) return;
    stoppedOnPurpose.add(sessionId);
    await d.runtime.stop(sessionId);
  }

  // From now on exits are only recorded; nothing is retried or merged.
  async function shutdown(): Promise<void> {
    shuttingDown = true;
    await d.runtime.stopAll();
    await idle();
  }

  async function alreadyMerged(worktree: string, branch: string): Promise<boolean> {
    try {
      await git(["merge-base", "--is-ancestor", branch, "HEAD"], worktree);
      return true;
    } catch {
      return false;
    }
  }

  function enqueueMerge(runId: string, parentId: string, childId: string): void {
    const key = `${runId}/${parentId}`;
    const next = (merges.get(key) ?? Promise.resolve())
      .then(() => mergeChild(runId, parentId, childId))
      .catch(report);
    merges.set(key, next);
    void next.then(() => { if (merges.get(key) === next) merges.delete(key); });
  }

  // Runs the parent's agent on a conflicted merge and waits for it to finish.
  async function resolveWithAgent(run: Run, parent: Node, child: Node, conflicts: string[]): Promise<{ ok: boolean; reason: string }> {
    const sessionId = sessionIdOf(run.id, parent.id);
    let exited!: Promise<number | null>;
    try {
      const launchId = await launch(run, parent, conflictPrompt(run, parent, child, conflicts));
      exited = new Promise((resolve) => exitWaiters.set(launchId, resolve));
      if (!d.runtime.isAlive(sessionId)) {
        // Exited before we listened.
        exitWaiters.delete(launchId);
        exited = Promise.resolve(d.runtime.output(sessionId, 1)?.exitCode ?? null);
      }
    } catch (e) {
      return { ok: false, reason: `could not start the parent's agent: ${(e as Error).message}` };
    }
    await exited;
    const result = await finishResolution(parent.worktree, conflicts);
    return result.ok ? { ok: true, reason: "" } : { ok: false, reason: result.reason };
  }

  async function mergeChild(runId: string, parentId: string, childId: string): Promise<void> {
    let run = await load(runId);
    const parent = nodeOf(run, parentId);
    const child = nodeOf(run, childId);
    // A parent waiting on the user keeps finished children until resume.
    if (shuttingDown || !["waiting", "failed"].includes(parent.status)) return;
    if (child.kind === "leaf" && (child.status === "done" || child.status === "skipped")) return;
    if (child.kind === "parent" && (await alreadyMerged(parent.worktree, child.branch))) return;
    await transition(runId, parentId, "integrating");
    const before = await headOf(parent.worktree);
    const merged = await mergeBranch(parent.worktree, child.branch, `Merge "${child.title}" (${child.id})`);
    if (!merged.ok) {
      const resolved = await resolveWithAgent(run, parent, child, merged.conflicts);
      if (!resolved.ok) {
        await abortMerge(parent.worktree).catch(report);
        if ((await headOf(parent.worktree)) !== before) await resetTo(parent.worktree, before).catch(report);
        const why = `merging "${child.title}" conflicts in ${merged.conflicts.join(", ")}: ${resolved.reason}`;
        await transition(runId, parentId, "escalated", why);
        return;
      }
    }

    const { check } = await d.write(() => d.store.getConfig(run.project));
    if (check) {
      const result = await runCommand(check, parent.worktree, checkTimeout);
      if (!result.ok) {
        await resetTo(parent.worktree, before);
        await transition(runId, parentId, "waiting");
        const why = `check "${check}" failed after merging "${child.title}":\n${result.output}`;
        if (child.kind === "leaf") {
          await leafFailedAfterMerge(runId, childId, why);
        } else {
          await transition(runId, parentId, "escalated", why);
        }
        return;
      }
    }

    if (child.kind === "leaf") await transition(runId, childId, "done");
    await tellSiblings(run, parent, child);
    run = await load(runId);
    const rest = childrenOf(run, parentId).filter((c) => c.status !== "done" && c.status !== "skipped");
    if (rest.length > 0) {
      await transition(runId, parentId, "waiting");
      return;
    }
    if (parent.parentId === null) {
      await completeRoot(runId);
    } else {
      await transition(runId, parentId, "done");
      await d.write(() => d.store.updateNode(runId, parentId, { finishedAt: new Date().toISOString() }));
      enqueueMerge(runId, parent.parentId, parentId);
    }
  }

  // A merged leaf broke the check: it gets the check output and one more go.
  async function leafFailedAfterMerge(runId: string, childId: string, why: string): Promise<void> {
    const run = await load(runId);
    const child = nodeOf(run, childId);
    if (child.attempts < MAX_ATTEMPTS) {
      await transition(runId, childId, "failed", why);
      await runLeaf(runId, childId, why);
    } else {
      await transition(runId, childId, "escalated", `gave up after ${child.attempts} attempts: ${why}`);
    }
  }

  async function tellSiblings(run: Run, parent: Node, child: Node): Promise<void> {
    const message = `Note from Rivet: "${child.title}" is finished and merged into ${parent.branch}.`;
    for (const s of childrenOf(run, parent.id)) {
      if (s.id === child.id || s.kind !== "leaf" || s.status !== "running" || s.finishedAt) continue;
      const id = await d.write(() => d.store.queueMessage(run.id, s.id, message, sessionIdOf(run.id, parent.id)));
      if (id !== null) await deliverQueued(run.id, s.id).catch(report);
    }
  }

  // Everything is merged into the root: the full test decides.
  async function completeRoot(runId: string): Promise<void> {
    const run = await load(runId);
    const root = run.nodes[0]!;
    const { test } = await d.write(() => d.store.getConfig(run.project));
    if (root.kind === "parent" && root.status !== "integrating") await transition(runId, root.id, "integrating");
    if (test) {
      const result = await runCommand(test, root.worktree, testTimeout);
      if (!result.ok) {
        await transition(runId, root.id, root.kind === "leaf" ? "escalated" : "failed",
          `tests "${test}" failed on the integrated result:\n${result.output}`);
        return;
      }
    }
    await transition(runId, root.id, "done");
  }

  // Puts escalated and failed nodes back to work after the user fixed what blocked them,
  // then continues whatever was interrupted.
  async function resume(runId: string): Promise<void> {
    const run = await load(runId);
    for (const n of run.nodes) {
      if (n.kind === "parent" && (n.status === "escalated" || n.status === "failed")) {
        await abortMerge(n.worktree).catch(report);
        await transition(runId, n.id, "waiting");
      }
    }
    for (const n of run.nodes) {
      if (n.kind === "leaf" && (n.status === "escalated" || n.status === "failed")) {
        await runLeaf(runId, n.id, n.summary).catch(report);
      }
    }
    await recover(runId);
  }

  // After a daemon restart (or a resume): finish what was in flight. Idempotent.
  async function recover(runId: string): Promise<void> {
    const run = await load(runId);
    if (run.nodes.every((n) => n.status === "pending") || FINAL_RUN.includes(run.nodes[0]!.status)) return;
    for (const p of run.nodes.filter((n) => n.kind === "parent")) {
      if (p.status === "integrating") {
        if (await mergeInProgress(p.worktree).catch(() => false)) await abortMerge(p.worktree).catch(report);
        await transition(runId, p.id, "waiting");
      }
    }
    const fresh = await load(runId);
    for (const n of fresh.nodes) {
      const sessionId = sessionIdOf(runId, n.id);
      if (n.kind === "leaf" && n.status === "pending") {
        await runLeaf(runId, n.id).catch(report);
      } else if (n.kind === "leaf" && n.status === "running") {
        if (n.finishedAt) {
          if (n.parentId) enqueueMerge(runId, n.parentId, n.id);
          else await completeRoot(runId);
        } else if (!d.runtime.isAlive(sessionId)) {
          await launch(fresh, n, leafPrompt(fresh, n, "Rivet was restarted while you worked; continue from the current state of the worktree.")).catch(report);
        }
      }
    }
    // Parents whose children are all merged but which never moved on.
    for (const p of [...fresh.nodes].reverse().filter((n) => n.kind === "parent")) {
      const kids = childrenOf(fresh, p.id);
      if (p.status === "waiting" && kids.every((k) => k.status === "done" || k.status === "skipped")) {
        if (p.parentId === null) await completeRoot(runId);
        else {
          await transition(runId, p.id, "integrating");
          await transition(runId, p.id, "done");
          enqueueMerge(runId, p.parentId, p.id);
        }
      } else if (p.status === "done" && p.parentId) {
        const up = nodeOf(fresh, p.parentId);
        if (up.status === "waiting") enqueueMerge(runId, p.parentId, p.id);
      }
    }
  }

  // Resolves once no merge is queued or running (tests and shutdown).
  async function idle(): Promise<void> {
    while (merges.size > 0) await Promise.all([...merges.values()]);
  }

  d.runtime.onExit((sessionId, launchId, code) => { void onExit(sessionId, launchId, code).catch(report); });

  return { launch, startRun, onReport, resume, recover, idle, stopSession, shutdown, deliver: deliverQueued };
}

export type Scheduler = ReturnType<typeof createScheduler>;
