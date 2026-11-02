import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { allowedRequest, serveApp } from "../src/daemon/web.js";
import { makeDataDir, removeRepo } from "./helpers.js";

let data: string;
let daemon: Daemon | undefined;

beforeEach(async () => { data = await makeDataDir(); });
afterEach(async () => { await daemon?.stop(); daemon = undefined; await removeRepo(data); });

const url = (path: string) => `http://127.0.0.1:${daemon!.port}${path}`;

describe("who may reach the daemon", () => {
  it("refuses a page elsewhere and a site name pointed at this machine", () => {
    expect(allowedRequest({ host: "127.0.0.1:4319" })).toBe(true);
    expect(allowedRequest({ host: "localhost:4319", origin: "http://localhost:4319" })).toBe(true);
    expect(allowedRequest({ host: "127.0.0.1:4319", origin: "https://evil.example" })).toBe(false);
    expect(allowedRequest({ host: "evil.example:4319" })).toBe(false);
    expect(allowedRequest({ host: "127.0.0.1:4319", "sec-fetch-site": "cross-site" })).toBe(false);
    expect(allowedRequest({})).toBe(false);
  });

  it("does not start work for a cross-site request", async () => {
    daemon = await startDaemon({ data, runFile: join(data, "r.json"), port: 0 });
    const r = await fetch(url("/api/v1/runs"), { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ repo: data, task: "x" }) });
    expect(r.status).toBe(403);
  });

  it("refuses a socket from elsewhere and tells the app when state moves", async () => {
    daemon = await startDaemon({ data, runFile: join(data, "r.json"), port: 0 });
    const ws = `ws://127.0.0.1:${daemon.port}/api/v1/live`;
    const refused = await new Promise((resolve) => {
      const s = new WebSocket(ws, { origin: "https://evil.example" });
      s.on("open", () => { resolve(false); s.close(); });
      s.on("error", () => resolve(true));
    });
    expect(refused).toBe(true);
    const s = new WebSocket(ws, { origin: `http://127.0.0.1:${daemon.port}` });
    await new Promise((resolve) => s.on("open", resolve));
    const changed = new Promise((resolve) => s.on("message", (m) => { if (JSON.parse(String(m)).type === "changed") resolve(true); }));
    await fetch(url("/api/v1/projects/p1/config"), { method: "PUT", body: JSON.stringify({ key: "check", value: "true" }) });
    expect(await changed).toBe(true);
    s.close();
  });
});

describe("the app's files", () => {
  it("serve from its folder only, with the page as fallback", async () => {
    const root = join(data, "web");
    await mkdir(root);
    await writeFile(join(root, "index.html"), "PAGE");
    await writeFile(join(data, "secret.txt"), "SECRET");
    const seen = async (path: string) => {
      let out = "";
      let headers: Record<string, string> = {};
      const res = { writeHead: (_: number, h: Record<string, string>) => { headers = h; }, end: (b: Buffer) => { out = String(b); } };
      await serveApp(path, res as never, root);
      return { out, headers };
    };
    expect((await seen("/some/route")).out).toBe("PAGE");
    expect((await seen("/../secret.txt")).out).toBe("PAGE");
    expect((await seen("/%2e%2e/secret.txt")).out).toBe("PAGE");
    expect((await seen("/")).headers["content-security-policy"]).toContain("default-src 'none'");
  });
});
