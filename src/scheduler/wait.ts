import { setTimeout as delay } from "node:timers/promises";

export type WaitSnapshot = {
  status: string; activity?: string; live: boolean; pending?: boolean; retrying?: boolean;
  turn?: { id: string; state: string };
  pendingRequest?: { tool: string; detail: string } | null;
};
// Waiting happens in the daemon without generating repeated agent tool calls.
export async function waitForRun(read: (turn?: string) => Promise<WaitSnapshot>, options: { scope: "turn" | "task"; timeoutMs: number; turn?: string }, signal: AbortSignal) {
  const deadline = Date.now() + options.timeoutMs;
  let snapshot = await read(options.turn);
  let turn = options.turn ?? (snapshot.pending ? undefined : snapshot.turn?.id);
  for (;;) {
    signal.throwIfAborted();
    if (!turn && !snapshot.pending) turn = snapshot.turn?.id;
    const taskEnded = ["done", "failed", "escalated"].includes(snapshot.status) && !snapshot.retrying;
    const turnEnded = turn
      ? snapshot.turn?.id === turn && snapshot.turn.state !== "working"
      : !snapshot.live || !["busy", "approval", "asking"].includes(snapshot.activity ?? "idle");
    const finished = options.scope === "task" ? taskEnded
      : taskEnded || !snapshot.live || ((!snapshot.pending || !!options.turn) && turnEnded);
    if (finished) return { ...snapshot, timedOut: false, scope: options.scope, ...(turn ? { turnId: turn } : {}) };
    const left = deadline - Date.now();
    if (left <= 0) return { ...snapshot, timedOut: true, scope: options.scope, ...(turn ? { turnId: turn } : {}) };
    await delay(Math.min(100, left), undefined, { signal });
    snapshot = await read(turn);
  }
}
