import type { ChildProcess } from "node:child_process";

// JSON-RPC 2.0 over a child's stdin and stdout, one message per line: calls Rivet makes,
// notifications it gets, and requests the agent makes of Rivet (which Rivet answers).
export type RpcHandlers = {
  notify(method: string, params: Record<string, unknown>): void;
  request(method: string, params: Record<string, unknown>, id: number | string): void;
};

export class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "RpcError";
  }
}

export type Rpc = {
  call(method: string, params: unknown): Promise<Record<string, unknown>>;
  notify(method: string, params?: unknown): void;
  respond(id: number | string, result: unknown): void;
  fail(id: number | string, code: number, message: string): void;
  // Every line the agent wrote, for the record (raw provider events).
  onLine(fn: (line: string) => void): void;
  closed: Promise<void>;
};

// jsonrpc: whether messages carry "jsonrpc": "2.0" (Codex's app-server leaves it out).
export function connect(child: ChildProcess, handlers: RpcHandlers, o: { jsonrpc: boolean }): Rpc {
  let next = 0;
  const waiting = new Map<number, { resolve(v: Record<string, unknown>): void; reject(e: Error): void }>();
  const lineListeners: ((line: string) => void)[] = [];
  const tag = o.jsonrpc ? { jsonrpc: "2.0" } : {};
  const write = (m: Record<string, unknown>) => { child.stdin?.write(JSON.stringify({ ...tag, ...m }) + "\n"); };
  let partial = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const fn of lineListeners) fn(line);
      let m: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code?: number; message?: string } };
      try { m = JSON.parse(line); } catch { continue; }
      if (m.method !== undefined && m.id !== undefined) handlers.request(m.method, m.params ?? {}, m.id);
      else if (m.method !== undefined) handlers.notify(m.method, m.params ?? {});
      else if (typeof m.id === "number" && waiting.has(m.id)) {
        const w = waiting.get(m.id)!;
        waiting.delete(m.id);
        if (m.error) w.reject(new RpcError(m.error.message ?? "error", m.error.code));
        else w.resolve(m.result ?? {});
      }
    }
  });
  const closed = new Promise<void>((resolve) => child.once("exit", () => {
    for (const w of waiting.values()) w.reject(new RpcError("agent exited"));
    waiting.clear();
    resolve();
  }));
  return {
    call(method, params) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        write({ id, method, params });
      });
    },
    notify(method, params) { write({ method, ...(params !== undefined ? { params } : {}) }); },
    respond(id, result) { write({ id, result }); },
    fail(id, code, message) { write({ id, error: { code, message } }); },
    onLine(fn) { lineListeners.push(fn); },
    closed,
  };
}
