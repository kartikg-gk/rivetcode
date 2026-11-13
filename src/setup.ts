import { execFile } from "node:child_process";
import { findClaude, findCodex } from "./agents/locate.js";
import { ollamaBase, ollamaModels } from "./chat/ollama.js";

// What a new user needs before a first thread: an agent CLI that is installed and logged in,
// or a local model through Ollama. Each check says what to run to fix it.

export type AgentSetup = {
  agent: "claude" | "codex";
  name: string;
  installed: boolean;
  path?: string;
  version?: string;
  // null: installed, but whether it is logged in could not be told.
  loggedIn: boolean | null;
  problem?: string;
  install: string;
  login: string;
  docs: string;
};
export type LocalSetup = { running: boolean; models: string[]; install: string; pull: string; docs: string };
export type Setup = { agents: AgentSetup[]; ollama: LocalSetup; ready: boolean; checkedAt: string };

type Run = (file: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

const runFile: Run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 20_000, windowsHide: true, shell: /\.(cmd|bat)$/i.test(file), env: { ...process.env, NO_COLOR: "1" } },
    (error, stdout, stderr) => resolve({ ok: !error, out: `${stdout}\n${stderr}`.trim() }));
});

const AGENTS = {
  claude: {
    name: "Claude Code", find: findClaude,
    install: process.platform === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash",
    login: "claude auth login", docs: "https://docs.anthropic.com/en/docs/claude-code/setup",
    status: ["auth", "status"],
    loggedIn: (r: { ok: boolean; out: string }) => {
      const json = /\{[\s\S]*\}/.exec(r.out)?.[0];
      if (json) { try { return (JSON.parse(json) as { loggedIn?: boolean }).loggedIn === true; } catch { /* not JSON */ } }
      return r.ok ? null : false;
    },
  },
  codex: {
    name: "Codex", find: findCodex,
    install: "npm install -g @openai/codex", login: "codex login", docs: "https://developers.openai.com/codex/cli",
    status: ["login", "status"],
    loggedIn: (r: { ok: boolean; out: string }) => (/not logged in/i.test(r.out) ? false : r.ok && /logged in/i.test(r.out) ? true : r.ok ? null : false),
  },
} as const;

export async function checkAgent(agent: "claude" | "codex", run: Run = runFile): Promise<AgentSetup> {
  const a = AGENTS[agent];
  const base = { agent, name: a.name, install: a.install, login: a.login, docs: a.docs };
  let path: string;
  try { path = a.find(); } catch (e) { return { ...base, installed: false, loggedIn: false, problem: (e as Error).message }; }
  const [version, status] = await Promise.all([run(path, ["--version"]), run(path, [...a.status])]);
  if (!version.ok) return { ...base, installed: false, path, loggedIn: false, problem: `${path} did not start: ${version.out.slice(0, 300)}` };
  const loggedIn = a.loggedIn(status);
  return { ...base, installed: true, path, version: version.out.split(/\r?\n/)[0]!.slice(0, 80), loggedIn,
    ...(loggedIn === false ? { problem: `${a.name} is not logged in` } : {}) };
}

export async function checkOllama(env: Record<string, string | undefined> = process.env): Promise<LocalSetup> {
  const base = { install: "https://ollama.com/download", pull: "ollama pull qwen3:8b", docs: "https://ollama.com" };
  try {
    const up = await fetch(`${ollamaBase(env)}/api/version`, { signal: AbortSignal.timeout(2_000) });
    if (!up.ok) return { ...base, running: false, models: [] };
    return { ...base, running: true, models: await ollamaModels(env).catch(() => []) };
  } catch {
    return { ...base, running: false, models: [] };
  }
}

export async function checkSetup(run: Run = runFile): Promise<Setup> {
  const [claude, codex, ollama] = await Promise.all([checkAgent("claude", run), checkAgent("codex", run), checkOllama()]);
  const agents = [claude, codex];
  return { agents, ollama, ready: agents.some((a) => a.installed && a.loggedIn !== false) || ollama.models.length > 0, checkedAt: new Date().toISOString() };
}
