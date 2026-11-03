// The daemon's HTTP API and its live socket.
export type RunRow = {
  id: string; project: string; task: string; createdAt: string; status: string; role: string; name: string; agent: string;
  live: boolean; orchestrator?: string; repo: string; activity: string | null; sessionMode: string;
  organization: { archivedAt: string | null; group: string; pinnedAt: string | null; snoozedUntil: string | null; unread: boolean; busy: string | null }; needsAnswer: boolean;
};
export type RunDetail = {
  run: {
    id: string; project: string; repo: string; base: string; task: string; role: string; name: string; orchestrator?: string; model?: string; issue?: number;
    spec?: Record<string, unknown>; sharedWorkspace?: string;
    node: { agent: string; branch: string; worktree: string; status: string; attempts: number; summary?: string; activity?: string; activityAt?: string; sessionMode?: string; prStatus?: string };
  };
  live: boolean; pr: { number: number; url: string } | null; terminateOnPrMerge: boolean; noSignal: unknown;
  usage: { conversations: number; inputEquivalent: number; tokens: Record<string, number> };
  reviews: { id: number; sha: string; trigger: string; status?: string; verdict?: string; summary?: string }[];
  terminal: boolean; pendingRequest?: { tool: string; detail: string; at: string };
  secretRequest?: { id: string; name: string; why: string; at: string };
  chatUsage?: { input: number; output: number; cached: number; total: number; contextUsed?: number; contextWindow?: number };
  fork?: { sourceRun: string; position: number; strategy: string; detached: boolean } | null;
};
export type Item = {
  position: number; session: string; kind: string; tool?: string; text: string; at: string; streaming?: boolean;
  textOffset?: number; nextTextOffset?: number | null; cut?: { shown: number; length: number };
};
export type Page = { view: string; total: number; items: Item[]; next?: number };

export class ApiError extends Error {}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const value = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(value.error ?? `request failed (${response.status})`);
  return value as T;
}

export const runPath = (id: string, tail = "") => `/runs/${encodeURIComponent(id)}${tail}`;
export const sessionOf = (id: string) => `${id}-agent`;

type Message =
  | { type: "changed" } | { type: "output"; session: string; data: string }
  | { type: "exit"; session: string } | { type: "error"; session: string; error: string };

const changeListeners = new Set<() => void>();
const connectionListeners = new Set<(up: boolean) => void>();
const terminalListeners = new Map<string, (m: Message) => void>();
let socket: WebSocket | undefined;
let up = false;

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/api/v1/live`);
  socket.onopen = () => {
    up = true;
    for (const f of connectionListeners) f(true);
    for (const f of changeListeners) f();
    for (const session of terminalListeners.keys()) socket!.send(JSON.stringify({ type: "attach", session }));
  };
  socket.onclose = () => {
    up = false;
    for (const f of connectionListeners) f(false);
    setTimeout(connect, 1500);
  };
  socket.onmessage = (event) => {
    const m = JSON.parse(String(event.data)) as Message;
    if (m.type === "changed") for (const f of changeListeners) f();
    else terminalListeners.get(m.session)?.(m);
  };
}
connect();

export function onChanged(f: () => void): () => void {
  changeListeners.add(f);
  return () => { changeListeners.delete(f); };
}
export function onConnection(f: (up: boolean) => void): () => void {
  connectionListeners.add(f);
  f(up);
  return () => { connectionListeners.delete(f); };
}

const sendRaw = (value: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };

export function openTerminal(session: string, listener: (m: Message) => void) {
  terminalListeners.set(session, listener);
  sendRaw({ type: "attach", session });
  return {
    input: (data: string) => sendRaw({ type: "input", session, data }),
    resize: (cols: number, rows: number) => sendRaw({ type: "resize", session, cols, rows }),
    close: () => { terminalListeners.delete(session); sendRaw({ type: "detach", session }); },
  };
}
