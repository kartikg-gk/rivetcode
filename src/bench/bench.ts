import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "../agents/agent.js";
import { startDaemon } from "../daemon/server.js";
import { git } from "../git.js";
import type { Run } from "../store.js";
import type { Node, PlanNode } from "../tree.js";
import { waitForTrash } from "../worktree.js";
import { addTokens, claudeSessionTokens, NO_TOKENS, type TokenUse } from "./tokens.js";

// One task, the same repo, several ways of splitting it (e.g. single, flat, tree).
export type BenchSpec = {
  name: string;
  repo: string;
  task: string;
  // Full test on the integrated result; a mode passes when its root ends "done".
  test?: string;
  // Check after every merge.
  check?: string;
  model?: string;
  permission?: string;
  timeoutMinutes?: number;
  modes: Record<string, PlanNode>;
};

export type ModeResult = {
  mode: string;
  runId: string;
  rootStatus: string;
  passed: boolean;
  seconds: number;
  leaves: number;
  attempts: number;
  escalations: number;
  // Merges that needed the parent's agent to resolve a conflict, plus unresolved ones.
  conflicts: number;
  tokens: TokenUse;
  error?: string;
};

export type BenchResult = { name: string; startedAt: string; results: ModeResult[]; verdict: string };

const BUSY = (n: Node) => (n.status === "running" && !n.finishedAt) || n.status === "integrating";

async function runMode(spec: BenchSpec, mode: string, plan: PlanNode, workDir: string, agents?: (name: Node["agent"]) => Agent): Promise<ModeResult> {
  const dir = join(workDir, mode);
  const repo = join(dir, "repo");
  await mkdir(dir, { recursive: true });
  await git(["clone", "-q", "--no-hardlinks", spec.repo, repo], dir);
  for (const key of ["user.name", "user.email"]) {
    const value = (await git(["config", key], spec.repo).catch(() => "")).trim() || (key === "user.name" ? "rivet bench" : "bench@rivet.local");
    await git(["config", key, value], repo);
  }
  const daemon = await startDaemon({
    data: join(dir, "data"), runFile: join(dir, "running.json"), port: 0, ...(agents ? { agents } : {}),
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const started = Date.now();
  let run: Run | undefined;
  let error: string | undefined;
  try {
    const project = repo.split(/[\\/]/).pop()!.toLowerCase().trim().replace(/ /g, "-");
    const settings: Record<string, string | undefined> = {
      test: spec.test, check: spec.check, "worker.model": spec.model, "worker.permission": spec.permission,
    };
    for (const [key, value] of Object.entries(settings)) {
      if (value) await api("PUT", `/api/v1/projects/${encodeURIComponent(project)}/config`, { key, value });
    }
    const { runId } = await api("POST", "/api/v1/runs", { repo, task: spec.task, plan });
    const deadline = started + (spec.timeoutMinutes ?? 30) * 60_000;
    for (;;) {
      run = (await api("GET", `/api/v1/runs/${runId}`)).run as Run;
      const root = run.nodes[0]!;
      const finished = ["done", "failed", "escalated"].includes(root.status) && !run.nodes.some(BUSY);
      const stuck = !run.nodes.some(BUSY) && run.nodes.some((n) => n.status === "escalated");
      if (finished || stuck) { await daemon.idle(); run = (await api("GET", `/api/v1/runs/${runId}`)).run as Run; break; }
      if (Date.now() > deadline) { error = `timed out after ${spec.timeoutMinutes ?? 30} minutes`; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    error = (e as Error).message;
  } finally {
    await daemon.stop();
    await waitForTrash();
  }
  const nodes = run?.nodes ?? [];
  const tokens = nodes.reduce((t, n) => (n.agentSessionId ? addTokens(t, claudeSessionTokens(n.agentSessionId)) : t), NO_TOKENS);
  return {
    mode,
    runId: run?.id ?? "",
    rootStatus: nodes[0]?.status ?? "not started",
    passed: nodes[0]?.status === "done" && !error,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    leaves: nodes.filter((n) => n.kind === "leaf").length,
    attempts: nodes.filter((n) => n.kind === "leaf").reduce((a, n) => a + n.attempts, 0),
    escalations: nodes.filter((n) => n.status === "escalated").length,
    conflicts: nodes.filter((n) => n.kind === "parent" && (n.activity !== undefined || /conflicts in/.test(n.summary ?? ""))).length,
    tokens,
    ...(error ? { error } : {}),
  };
}

// The rule written down before measuring: if the tree does not beat flat on a
// multi-part task, the tree is dropped.
export function killRuleVerdict(results: ModeResult[]): string {
  const tree = results.find((r) => r.mode === "tree");
  const flat = results.find((r) => r.mode === "flat");
  if (!tree || !flat) return "kill rule: not decided (needs both a flat and a tree mode)";
  const wins = tree.passed && (!flat.passed || (tree.seconds <= flat.seconds * 1.1 && tree.conflicts <= flat.conflicts && tree.escalations <= flat.escalations));
  return wins
    ? `kill rule: tree beats flat (${tree.seconds}s vs ${flat.seconds}s, conflicts ${tree.conflicts} vs ${flat.conflicts})`
    : `kill rule: tree does NOT beat flat (${tree.seconds}s vs ${flat.seconds}s, passed ${tree.passed} vs ${flat.passed}, conflicts ${tree.conflicts} vs ${flat.conflicts}) - drop the tree for this kind of task`;
}

export async function runBench(spec: BenchSpec, o: { workDir: string; agents?: (name: Node["agent"]) => Agent; log?(line: string): void }): Promise<BenchResult> {
  const startedAt = new Date().toISOString();
  const results: ModeResult[] = [];
  // One mode at a time, so they do not compete for the machine.
  for (const [mode, plan] of Object.entries(spec.modes)) {
    o.log?.(`running ${mode}...`);
    const result = await runMode(spec, mode, plan, o.workDir, o.agents);
    o.log?.(formatResult(result));
    results.push(result);
  }
  return { name: spec.name, startedAt, results, verdict: killRuleVerdict(results) };
}

export function formatResult(r: ModeResult): string {
  const tokens = r.tokens.input + r.tokens.cacheWrite + r.tokens.cacheRead + r.tokens.output;
  return `${r.mode.padEnd(8)} ${r.passed ? "pass" : "FAIL"}  ${String(r.seconds).padStart(7)}s  leaves ${r.leaves}  attempts ${r.attempts}  conflicts ${r.conflicts}  escalated ${r.escalations}  tokens ${tokens} (out ${r.tokens.output})${r.error ? `  error: ${r.error}` : ""}`;
}
