import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { Runtime } from "../runtime/runtime.js";

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

function hostName(value: string): string | null {
  try { return new URL(`http://${value}`).hostname; } catch { return null; }
}

// The daemon can start agents, so a web page must not reach it. A browser names where a
// request came from; a page elsewhere, or a site whose name was pointed at this machine,
// is refused. Clients that are not browsers send no Origin and pass on Host alone.
export function allowedRequest(headers: IncomingMessage["headers"]): boolean {
  const host = headers.host === undefined ? null : hostName(headers.host);
  if (host === null || !LOOPBACK.includes(host)) return false;
  const site = headers["sec-fetch-site"];
  if (site === "cross-site") return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.includes(url.hostname);
  } catch { return false; }
}

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".map": "application/json",
};
// Agent text and tool output are shown in this page, so it may load nothing from elsewhere.
const PAGE_POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Serves the built app; any path that is not a file is the app's own page.
export async function serveApp(path: string, res: ServerResponse, root = WEB_ROOT): Promise<boolean> {
  const inside = normalize(join(root, decodeURIComponent(path)));
  const rootDir = root.endsWith(sep) ? root : root + sep;
  const wanted = inside.startsWith(normalize(rootDir)) && (await stat(inside).catch(() => null))?.isFile() ? inside : join(root, "index.html");
  const content = await readFile(wanted).catch(() => null);
  if (!content) return false;
  res.writeHead(200, {
    "content-type": TYPES[extname(wanted)] ?? "application/octet-stream",
    "cache-control": wanted.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    "content-security-policy": PAGE_POLICY, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  });
  res.end(content);
  return true;
}

type Live = { server: Server; runtime: Runtime; changeCount(): number; sessionOf(id: string): string; pollMs?: number };
type ClientMessage =
  | { type: "attach"; session: string } | { type: "detach"; session: string }
  | { type: "input"; session: string; data: string } | { type: "resize"; session: string; cols: number; rows: number };

// One socket per open app: "changed" whenever stored state moved (the app refetches what it
// shows), and the terminals it asked for, both ways.
export function liveSocket(o: Live): { close(): void } {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const upgrade = (req: IncomingMessage, socket: NodeJS.WritableStream & { destroy(): void }, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/api/v1/live" || !allowedRequest(req.headers) || req.headers.origin === undefined) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket as never, head, (ws) => { serve(ws); });
  };
  o.server.on("upgrade", upgrade as never);
  const send = (ws: WebSocket, value: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value)); };

  function serve(ws: WebSocket): void {
    const watching = new Map<string, () => void>();
    const offExit = o.runtime.onExit((s) => { if (watching.has(s)) { watching.get(s)!(); watching.delete(s); send(ws, { type: "exit", session: s }); } });
    ws.on("close", () => { offExit(); for (const stop of watching.values()) stop(); watching.clear(); });
    ws.on("error", () => { ws.terminate(); });
    ws.on("message", (raw) => {
      let m: ClientMessage;
      try { m = JSON.parse(String(raw)) as ClientMessage; } catch { return; }
      let id: string;
      try { id = o.sessionOf(m.session); } catch { send(ws, { type: "error", session: m.session, error: "unknown session" }); return; }
      try {
        if (m.type === "attach") {
          watching.get(id)?.();
          const watch = o.runtime.attach(id, (data) => { send(ws, { type: "output", session: m.session, data }); });
          if (!watch) { send(ws, { type: "error", session: m.session, error: "this session has no terminal running" }); return; }
          watching.set(id, watch.detach);
          send(ws, { type: "output", session: m.session, data: watch.replay });
        } else if (m.type === "detach") {
          watching.get(id)?.();
          watching.delete(id);
        } else if (m.type === "input" && typeof m.data === "string") {
          o.runtime.input(id, m.data);
        } else if (m.type === "resize" && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols > 0 && m.rows > 0) {
          o.runtime.resize(id, m.cols, m.rows);
        }
      } catch (e) { send(ws, { type: "error", session: m.session, error: (e as Error).message }); }
    });
  }

  let seen = o.changeCount();
  const timer = setInterval(() => {
    if (sockets.clients.size === 0) return;
    let now: number;
    try { now = o.changeCount(); } catch { return; }
    if (now === seen) return;
    seen = now;
    for (const ws of sockets.clients) send(ws, { type: "changed" });
  }, o.pollMs ?? 250);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
      o.server.off("upgrade", upgrade as never);
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
    },
  };
}
