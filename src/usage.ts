import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProjectsDir } from "./agents/claude.js";

export type TokenUse = { input: number; cacheWrite: number; cacheRead: number; output: number };

export const NO_TOKENS: TokenUse = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

export function addTokens(a: TokenUse, b: TokenUse): TokenUse {
  return { input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output };
}

export function totalTokens(t: TokenUse): number {
  return t.input + t.cacheWrite + t.cacheRead + t.output;
}

// Claude Code keeps one transcript per session under <config>/projects/<folder>/<id>.jsonl.
// Each assistant message may be written several times while it streams; count it once.
export function claudeSessionTokens(sessionId: string, root = claudeProjectsDir()): TokenUse {
  if (!existsSync(root)) return NO_TOKENS;
  let total = NO_TOKENS;
  for (const folder of readdirSync(root)) {
    const file = join(root, folder, `${sessionId}.jsonl`);
    if (!existsSync(file)) continue;
    const seen = new Map<string, TokenUse>();
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.includes('"usage"')) continue;
      let entry: { message?: { id?: string; usage?: Record<string, number> } };
      try { entry = JSON.parse(line); } catch { continue; }
      const usage = entry.message?.usage;
      if (!usage) continue;
      seen.set(entry.message?.id ?? `line${seen.size}`, {
        input: usage.input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      });
    }
    for (const use of seen.values()) total = addTokens(total, use);
  }
  return total;
}

export function codexSessionsDir(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions");
}

function findFile(dir: string, matches: (name: string) => boolean, depth = 4): string | null {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isFile() && matches(e.name)) return join(dir, e.name);
  }
  if (depth === 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findFile(join(dir, e.name), matches, depth - 1);
    if (found) return found;
  }
  return null;
}

// Codex writes one rollout file per session (sessions/<y>/<m>/<d>/rollout-<time>-<id>.jsonl)
// with a running total in its token_count events; the last one is the session's use.
// Its input count includes the cached part.
export function codexSessionTokens(sessionId: string, root = codexSessionsDir()): TokenUse {
  const file = findFile(root, (name) => name.startsWith("rollout-") && name.endsWith(`-${sessionId}.jsonl`));
  if (!file) return NO_TOKENS;
  let last: Record<string, number> | undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.includes('"token_count"')) continue;
    try {
      const total = (JSON.parse(line) as { payload?: { info?: { total_token_usage?: Record<string, number> } } }).payload?.info?.total_token_usage;
      if (total) last = total;
    } catch { continue; }
  }
  if (!last) return NO_TOKENS;
  const cached = last.cached_input_tokens ?? 0;
  return {
    input: Math.max(0, (last.input_tokens ?? 0) - cached),
    cacheWrite: last.cache_write_input_tokens ?? 0,
    cacheRead: cached,
    output: last.output_tokens ?? 0,
  };
}

// Where an agent keeps a conversation, if it saved one.
export function conversationFile(agent: string, id: string): string | null {
  if (agent === "claude") {
    const root = claudeProjectsDir();
    if (!existsSync(root)) return null;
    for (const folder of readdirSync(root)) {
      const file = join(root, folder, `${id}.jsonl`);
      if (existsSync(file)) return file;
    }
    return null;
  }
  if (agent === "codex") return findFile(codexSessionsDir(), (name) => name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`));
  return null;
}

// What each kind of token costs next to a plain input token, from the providers' list
// prices (the ratios hold across their models). Cached reads are cheap, so a raw total
// mostly made of them overstates what a run cost.
const PRICE_RATIOS: Record<string, TokenUse> = {
  claude: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  codex: { input: 1, cacheWrite: 1, cacheRead: 0.1, output: 8 },
};

// Tokens weighted by price: what the run cost, counted in plain input tokens.
export function inputEquivalent(agent: string, t: TokenUse): number {
  const r = PRICE_RATIOS[agent];
  if (!r) return 0;
  return Math.round(t.input * r.input + t.cacheWrite * r.cacheWrite + t.cacheRead * r.cacheRead + t.output * r.output);
}

function conversationTokens(c: { agent: string; id: string }): TokenUse {
  return c.agent === "claude" ? claudeSessionTokens(c.id) : c.agent === "codex" ? codexSessionTokens(c.id) : NO_TOKENS;
}

// Tokens used by every agent conversation of a run, read from the agents' own files, and
// the same weighted by price. Conversations of an agent Rivet can not read (the test fake)
// count nothing.
export function runUsage(conversations: { agent: string; id: string }[]): { tokens: TokenUse; inputEquivalent: number } {
  let tokens = NO_TOKENS;
  let weighted = 0;
  for (const c of conversations) {
    const t = conversationTokens(c);
    tokens = addTokens(tokens, t);
    weighted += inputEquivalent(c.agent, t);
  }
  return { tokens, inputEquivalent: weighted };
}
