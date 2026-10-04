import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TokenUse = { input: number; cacheWrite: number; cacheRead: number; output: number };

export const NO_TOKENS: TokenUse = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

export function addTokens(a: TokenUse, b: TokenUse): TokenUse {
  return { input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output };
}

// Claude Code keeps one transcript per session under ~/.claude/projects/<folder>/<id>.jsonl.
// Each assistant message may be written several times while it streams; count it once.
export function claudeSessionTokens(sessionId: string, root = join(homedir(), ".claude", "projects")): TokenUse {
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
