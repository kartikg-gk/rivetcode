import { existsSync } from "node:fs";
import { git } from "../git.js";
import type { Agent } from "../agents/agent.js";
import {
  abortMerge, commitLeftovers, finishResolution, headOf, mergeBranch, mergeInProgress, resetTo, runCommand,
} from "../merge.js";
import { normalizePermission } from "../agents/command.js";
import { agentEnv, sessionIdOf } from "../runtime/env.js";
import { newLaunchId, type Runtime } from "../runtime/runtime.js";
import type { PullRequest, Run, Store } from "../store.js";
import { claimsOverlap, reopen, setStatus, type Node, type Status } from "../tree.js";
import { prStatus, type GitHub } from "../github/github.js";
import { checkNote, conflictPrompt, leafPrompt } from "./prompts.js";
import { cleanRun } from "./runs.js";

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
  // Rewrites a leaf's instructions after it failed twice; null keeps them.
  replan?(run: Run, node: Node, why: string): Promise<string | null>;
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
  // Skipped leaves whose finished work is being turned into a follow-up pull request.
  const followingUp = new Set<string>();
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
    // The agent must be able to run what Rivet will judge its work by.
    for (const command of [config.check, config.test].map((c) => c?.trim()).filter((c): c is string => !!c)) {
      allowedTools.push(`Bash(${command})`, `Bash(${command}:*)`);
    }
    const check = config.check?.trim();
    if (check && prompt !== undefined && node.kind === "leaf" && node.agent !== "fake") prompt += checkNote(check);
    // interactive: the agent's own app in a terminal you can attach to; headless: it runs to the end on its own.
    const headless = config["worker.mode"] !== "interactive";
    const argv = await agent.launchCommand({
      sessionId, workspace: node.worktree, headless,
      permission: normalizePermission(config["worker.permission"] ?? DEFAULT_PERMISSION),
      ...(model ? { model } : {}),
      ...(allowedTools.length ? { allowedTools } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    });
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
    // Any failure noted on an earlier attempt is over now.
    await d.write(() => d.store.updateNode(runId, nodeId, { finishedAt: new Date().toISOString(), summary: null }));
    if (node.parentId === null) {
      // A single-leaf run: the leaf is the root, nothing to merge into.
      await completeRoot(runId);
      return;
    }
    enqueueMerge(runId, node.parentId, nodeId);
  }

  // The failure ladder: retry once, then (with a planner) re-plan the leaf and retry
  // once more, then hand it to the user.
  async function leafFailed(runId: string, nodeId: string, why: string): Promise<void> {
    const run = await load(runId);
    const node = nodeOf(run, nodeId);
    if (node.status !== "running") return;
    if (node.attempts < MAX_ATTEMPTS) {
      await transition(runId, nodeId, "failed", why);
      await runLeaf(runId, nodeId, why);
      return;
    }
    if (node.attempts === MAX_ATTEMPTS && d.replan) {
      let prompt: string | null = null;
      try { prompt = await d.replan(run, node, why); } catch (e) { report(e); }
      if (prompt) {
        await transition(runId, nodeId, "failed", why);
        await d.write(() => d.store.updateNode(runId, nodeId, { prompt }));
        await runLeaf(runId, nodeId, why);
        return;
      }
    }
    await transition(runId, nodeId, "escalated", `gave up after ${node.attempts} attempts: ${why}`);
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
    if (node.status === "skipped") {
      if (code === 0 || doneReported.has(sessionId)) {
        followingUp.add(sessionId);
        try { await followUp(runId, nodeId); } finally { followingUp.delete(sessionId); }
      }
      return;
    }
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
    if (watcher) clearInterval(watcher);
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
          await leafFailed(runId, childId, why);
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
    // A run with a pull request pushes every new result; "pr=auto" opens one the first time.
    const config = await d.write(() => d.store.getConfig(run.project));
    const hasPr = (await d.write(() => d.store.getPr(runId))) !== null;
    if (d.github && (hasPr || config.pr === "auto")) await publish(runId).catch(report);
  }

  async function filesChanged(run: Run, branch: string): Promise<string[]> {
    const out = await git(["diff", "--name-only", `${run.base}...${branch}`], run.repo).catch(() => "");
    return out.split(/\r?\n/).filter(Boolean);
  }

  async function prBody(run: Run): Promise<string> {
    const lines = [
      run.task,
      "",
      "Rivet split this task into parts, ran an agent on each in its own worktree, and merged",
      "every part into this branch as soon as it was done (one merge commit per part).",
      "",
    ];
    for (const leaf of run.nodes.filter((n) => n.kind === "leaf")) {
      const files = await filesChanged(run, leaf.branch);
      lines.push(`- **${leaf.title}** (\`${leaf.id}\`, branch \`${leaf.branch}\`)${leaf.summary ? `: ${leaf.summary.split(/\r?\n/)[0]}` : ""}`);
      if (files.length) lines.push(`  files: ${files.map((f) => `\`${f}\``).join(", ")}`);
    }
    return lines.join("\n");
  }

  // Brings the latest base into the finished root, tests again if it moved, pushes the
  // root branch and opens the pull request if there is none yet. Never merges the PR.
  async function publish(runId: string): Promise<{ number: number; url: string }> {
    if (!d.github) throw new SchedulerError(409, "GitHub is not available");
    const run = await load(runId);
    const root = run.nodes[0]!;
    if (root.status !== "done") throw new SchedulerError(409, `run ${runId} is not done (root is ${root.status})`);
    const before = await headOf(root.worktree);
    try {
      await git(["fetch", "-q", "origin", run.base], root.worktree);
    } catch (e) {
      throw new SchedulerError(409, `cannot fetch ${run.base} from origin: ${(e as Error).message}`);
    }
    const synced = await mergeBranch(root.worktree, `origin/${run.base}`, `Merge latest ${run.base}`);
    if (!synced.ok) {
      const base: Node = { ...root, id: run.base, title: `latest ${run.base}`, branch: `origin/${run.base}` };
      const resolved = await resolveWithAgent(run, root, base, synced.conflicts);
      if (!resolved.ok) {
        await abortMerge(root.worktree).catch(report);
        if ((await headOf(root.worktree)) !== before) await resetTo(root.worktree, before).catch(report);
        const why = `merging the latest ${run.base} conflicts in ${synced.conflicts.join(", ")}: ${resolved.reason}`;
        await d.write(() => d.store.updateNode(runId, root.id, { summary: why, prStatus: "needs_input" }));
        throw new SchedulerError(409, why);
      }
    }
    if ((await headOf(root.worktree)) !== before) {
      const { test } = await d.write(() => d.store.getConfig(run.project));
      if (test) {
        const result = await runCommand(test, root.worktree, testTimeout);
        if (!result.ok) {
          await resetTo(root.worktree, before);
          const why = `tests "${test}" fail after merging the latest ${run.base}:\n${result.output}`;
          await d.write(() => d.store.updateNode(runId, root.id, { summary: why, prStatus: "needs_input" }));
          throw new SchedulerError(409, why);
        }
      }
    }
    await git(["push", "-q", "origin", `HEAD:refs/heads/${root.branch}`], root.worktree);
    const existing = await d.write(() => d.store.getPr(runId));
    if (existing) return { number: existing.number, url: existing.url };
    const github = await d.github(run);
    const pr = await github.createPr({ title: run.task, head: root.branch, base: run.base, body: await prBody(run) });
    await d.write(() => {
      d.store.setPr(runId, pr);
      d.store.updateNode(runId, root.id, { prStatus: "pr_open" });
    });
    return pr;
  }

  // Leaves whose claimed or changed files include one of the paths.
  async function owners(run: Run, paths: string[]): Promise<Node[]> {
    const found: Node[] = [];
    for (const leaf of run.nodes.filter((n) => n.kind === "leaf")) {
      const files = [...leaf.files, ...(await filesChanged(run, leaf.branch))];
      if (paths.some((p) => files.some((f) => claimsOverlap(f, p)))) found.push(leaf);
    }
    return found;
  }

  // Sends a finished leaf back to work with feedback; its parents wait for it again.
  async function reopenLeaf(runId: string, leafId: string, feedback: string): Promise<void> {
    await d.write(() => {
      let nodes = d.store.loadRun(runId).nodes;
      const chain: string[] = [];
      for (let n = nodes.find((x) => x.id === leafId); n; n = nodes.find((x) => x.id === n!.parentId)) chain.push(n.id);
      for (const id of chain) {
        if (nodes.find((x) => x.id === id)!.status === "done") nodes = reopen(nodes, id, id === leafId ? feedback : undefined);
      }
      for (const id of chain) {
        const n = nodes.find((x) => x.id === id)!;
        d.store.updateNode(runId, id, { status: n.status, attempts: n.attempts, finishedAt: null, ...(id === leafId ? { summary: feedback } : {}) });
      }
    });
    const run = await load(runId);
    const leaf = nodeOf(run, leafId);
    await launch(run, leaf, leafPrompt(run, leaf, feedback));
  }

  // One look at the pull request: record where it stands and act once on new feedback.
  async function checkPr(runId: string): Promise<string | null> {
    if (!d.github) return null;
    const pr = await d.write(() => d.store.getPr(runId));
    if (!pr) return null;
    const run = await load(runId);
    const root = run.nodes[0]!;
    if (root.prStatus === "merged") {
      await terminateAfterMerge(run, pr);
      return "merged";
    }
    if (root.prStatus === "terminated") return root.prStatus;
    const github = await d.github(run);
    const facts = await github.facts(pr.number);
    const status = prStatus(facts);
    await d.write(() => d.store.updateNode(runId, root.id, { prStatus: status }));
    if (status === "merged") {
      await terminateAfterMerge(await load(runId), pr);
      return status;
    }
    const key = `${status}:${facts.mergeability}:${facts.headSha}`;
    // Work is already under way, or this exact state was handled before.
    if (pr.handled === key || root.status !== "done") return status;
    if (status === "ci_failed") {
      const paths = await github.failedPaths(pr.number);
      for (const leaf of await owners(run, paths)) {
        await reopenLeaf(runId, leaf.id, `CI failed on the pull request in: ${paths.join(", ")}. Fix it.`);
      }
    } else if (status === "changes_requested") {
      const comments = await github.reviewComments(pr.number);
      for (const leaf of await owners(run, comments.map((c) => c.path))) {
        const files = [...leaf.files, ...(await filesChanged(run, leaf.branch))];
        const mine = comments.filter((c) => files.some((f) => claimsOverlap(f, c.path)));
        const text = mine.map((c) => `${c.path}${c.line ? `:${c.line}` : ""}: ${c.body}`).join("\n");
        await reopenLeaf(runId, leaf.id, `Review comments on the pull request:\n${text}\nAddress them.`);
      }
    } else if (facts.mergeability === "behind" || facts.mergeability === "conflicting") {
      await publish(runId).catch(report);
    }
    await d.write(() => d.store.setPr(runId, { ...pr, handled: key }));
    return status;
  }

  // A run whose user asked for it ends once its pull request is merged: after its agents
  // have gone quiet, they are stopped, the run is marked terminated and its worktrees go.
  // Branches stay, and a worktree with uncommitted work is never forced: it is kept and
  // named, and the run is terminated all the same.
  async function terminateAfterMerge(run: Run, pr: PullRequest): Promise<void> {
    if (!(await d.write(() => d.store.getTerminateOnPrMerge(run.id)))) return;
    if (run.nodes.some((n) => n.status === "running" || n.status === "integrating")) return;
    // A skipped leaf can still be working (or opening its follow-up): its work must not be lost.
    if (run.nodes.some((n) => d.runtime.isAlive(sessionIdOf(run.id, n.id)) || followingUp.has(sessionIdOf(run.id, n.id)))) return;
    for (const n of run.nodes) await stopSession(sessionIdOf(run.id, n.id));
    await d.write(() => d.store.updateNode(run.id, run.nodes[0]!.id, { prStatus: "terminated" }));
    const { kept } = await cleanRun(d.data, run);
    await d.write(() => d.store.setPr(run.id, { ...pr, handled: kept.length ? `terminated; kept ${kept.join(", ")}` : "terminated" }));
    if (kept.length) report(new Error(`run ${run.id}: kept worktrees with uncommitted work: ${kept.join(", ")}`));
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

  // Brings the parent's merged work into a running leaf. Its work is saved first. On a
  // conflict an agent that can be told resolves it (or the agent asked for the sync
  // itself); otherwise the merge is undone and the leaf carries on as it was.
  async function sync(runId: string, nodeId: string, o: { byAgent?: boolean } = {}): Promise<{ synced: boolean; conflicts: string[]; note: string }> {
    const run = await load(runId);
    const leaf = nodeOf(run, nodeId);
    if (leaf.kind !== "leaf") throw new SchedulerError(409, "only leaves sync");
    if (leaf.status !== "running" || leaf.finishedAt) throw new SchedulerError(409, `${nodeId} is not working (${leaf.status})`);
    if (!leaf.parentId) throw new SchedulerError(409, "a single-leaf run has no parent to sync with");
    const parent = nodeOf(run, leaf.parentId);
    if (await mergeInProgress(leaf.worktree)) throw new SchedulerError(409, "a merge is already in progress in this worktree");
    await commitLeftovers(leaf.worktree, `rivet: save work of "${leaf.title}" before syncing`);
    const merged = await mergeBranch(leaf.worktree, parent.branch, `Sync with "${parent.title}"`);
    if (merged.ok) return { synced: true, conflicts: [], note: `merged ${parent.branch} into ${leaf.branch}` };
    const sessionId = sessionIdOf(runId, nodeId);
    if (o.byAgent) {
      return { synced: false, conflicts: merged.conflicts, note: "resolve the conflicts, then commit the merge" };
    }
    const agent = d.agents(leaf.agent);
    if (d.runtime.isAlive(sessionId) && agent.acceptsInput({ headless: (await d.write(() => d.store.getConfig(run.project)))["worker.mode"] !== "interactive" })) {
      await d.runtime.write(sessionId, `Note from Rivet: I merged ${parent.branch} (your siblings' finished work) into your branch and it conflicts in: ${merged.conflicts.join(", ")}. Resolve those conflicts, commit the merge, then continue your part.`);
      return { synced: false, conflicts: merged.conflicts, note: "the leaf's agent was asked to resolve them" };
    }
    await abortMerge(leaf.worktree);
    return { synced: false, conflicts: merged.conflicts, note: "merge undone; the leaf continues on its own branch" };
  }

  // A parent whose remaining children are all done or skipped moves on.
  async function advance(runId: string, parentId: string): Promise<void> {
    const run = await load(runId);
    const parent = nodeOf(run, parentId);
    if (parent.status !== "waiting") return;
    if (childrenOf(run, parentId).some((c) => c.status !== "done" && c.status !== "skipped")) return;
    if (parent.parentId === null) {
      await completeRoot(runId);
    } else {
      await transition(runId, parentId, "integrating");
      await transition(runId, parentId, "done");
      await d.write(() => d.store.updateNode(runId, parentId, { finishedAt: new Date().toISOString() }));
      enqueueMerge(runId, parent.parentId, parentId);
    }
  }

  // The user ships without this leaf. Its agent keeps working; when it finishes, its
  // work becomes a follow-up pull request on top of what shipped.
  async function skip(runId: string, nodeId: string): Promise<void> {
    const run = await load(runId);
    const leaf = nodeOf(run, nodeId);
    if (leaf.kind !== "leaf") throw new SchedulerError(409, "only leaves can be skipped");
    if (!["pending", "running", "failed", "escalated"].includes(leaf.status)) throw new SchedulerError(409, `${nodeId} is ${leaf.status}`);
    const running = d.runtime.isAlive(sessionIdOf(runId, nodeId));
    await transition(runId, nodeId, "skipped",
      running ? "skipped by the user; still running, will become a follow-up" : "skipped by the user");
    if (leaf.parentId) await advance(runId, leaf.parentId);
    else await completeRoot(runId).catch(report);
  }

  async function followUp(runId: string, nodeId: string): Promise<void> {
    const run = await load(runId);
    const leaf = nodeOf(run, nodeId);
    const root = run.nodes[0]!;
    await commitLeftovers(leaf.worktree, `rivet: save work left uncommitted by "${leaf.title}"`);
    // On top of what shipped, so the follow-up applies cleanly after it.
    const shipped = await mergeBranch(leaf.worktree, root.branch, `Bring in the shipped work of "${run.task}"`).catch(() => ({ ok: false as const, conflicts: [] as string[] }));
    if (!shipped.ok) {
      await abortMerge(leaf.worktree).catch(report);
      await d.write(() => d.store.updateNode(runId, nodeId, {
        summary: `finished after it was skipped; merging the shipped work conflicts in ${shipped.conflicts.join(", ") || "?"}; its work is on ${leaf.branch}`,
      }));
      return;
    }
    const hasPr = (await d.write(() => d.store.getPr(runId))) !== null;
    if (!d.github || !hasPr) {
      await d.write(() => d.store.updateNode(runId, nodeId, { summary: `finished after it was skipped; its work is on ${leaf.branch}` }));
      return;
    }
    try {
      await git(["push", "-q", "origin", `HEAD:refs/heads/${leaf.branch}`], leaf.worktree);
      const github = await d.github(run);
      const pr = await github.createPr({
        title: `Follow-up: ${leaf.title}`, head: leaf.branch, base: run.base,
        body: `${leaf.title}\n\nThis part of "${run.task}" finished after the main pull request shipped without it.\n\n${leaf.prompt}`,
      });
      await d.write(() => d.store.updateNode(runId, nodeId, { summary: `follow-up pull request: ${pr.url}` }));
    } catch (e) {
      await d.write(() => d.store.updateNode(runId, nodeId, { summary: `finished after it was skipped; follow-up PR failed: ${(e as Error).message}` }));
    }
  }

  return { launch, startRun, onReport, resume, recover, idle, stopSession, shutdown, deliver: deliverQueued, publish, checkPr, watchPrs, sync, skip };
}

export type Scheduler = ReturnType<typeof createScheduler>;
