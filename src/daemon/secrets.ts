import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A secret an agent asked for. The person types it into a private card in the app; the
// agent only ever gets a file path, and the value never enters its conversation or Rivet's
// records. Files live under the data folder and go when the session ends.
export type SecretAsk = { id: string; name: string; why: string; at: string };

const WAIT_MS = 10 * 60_000;

export function secretKeeper(data: string) {
  const root = join(data, "secrets");
  const asks = new Map<string, SecretAsk & { settle(r: { path?: string; refused?: boolean }): void }>();
  return {
    // Whatever a stopped daemon left behind is gone before anything asks again.
    async clear(): Promise<void> { await rm(root, { recursive: true, force: true }); },
    async forget(sessionId: string): Promise<void> {
      asks.get(sessionId)?.settle({ refused: true });
      await rm(join(root, sessionId), { recursive: true, force: true });
    },
    pending(sessionId: string): SecretAsk | undefined {
      const a = asks.get(sessionId);
      return a ? { id: a.id, name: a.name, why: a.why, at: a.at } : undefined;
    },
    // Resolves when the person answers, refuses or does not answer in time.
    ask(sessionId: string, name: string, why: string): Promise<{ path?: string; refused?: boolean; expired?: boolean }> {
      if (asks.has(sessionId)) throw new Error("this session is already waiting for a secret");
      const id = randomBytes(8).toString("hex");
      return new Promise((resolve) => {
        const timer = setTimeout(() => { asks.delete(sessionId); resolve({ expired: true }); }, WAIT_MS);
        asks.set(sessionId, { id, name, why, at: new Date().toISOString(), settle: (r) => { clearTimeout(timer); asks.delete(sessionId); resolve(r); } });
      });
    },
    async answer(sessionId: string, id: string, value: string | null): Promise<boolean> {
      const a = asks.get(sessionId);
      if (!a || a.id !== id) return false;
      if (value === null) { a.settle({ refused: true }); return true; }
      const dir = join(root, sessionId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${id}.secret`);
      await writeFile(path, value, { mode: 0o600 });
      a.settle({ path });
      return true;
    },
  };
}
