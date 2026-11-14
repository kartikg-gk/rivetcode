import { PassThrough, Readable } from "node:stream";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { serveMcp, toolCaller } from "../src/mcp/server.js";
import { mcpLaunch } from "../src/mcp/launch.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { openStore } from "../src/store.js";
import { claudeChat, codexChat } from "../src/chat/drivers.js";
import { makeDataDir, removeRepo, sessionRun } from "./helpers.js";

const main = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
beforeAll(() => { execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.build.json"], { cwd: fileURLToPath(new URL("..", import.meta.url)) }); }, 120000);
let daemon: Daemon | undefined;
let data: string | undefined;
afterEach(async () => { await daemon?.stop(); daemon = undefined; if (data) await removeRepo(data); data = undefined; });
const frame = (id: number, method: string, params = {}) => ({ jsonrpc: "2.0", id, method, params });
async function exchange(messages: unknown[], call = async (_name: string, _args: unknown): Promise<unknown> => ({})) {
  const lines: any[] = [];
  await serveMcp(Readable.from(messages.map((m) => typeof m === "string" ? m + "\n" : JSON.stringify(m) + "\n")), (l) => lines.push(JSON.parse(l)), call);
  return lines;
}

describe("MCP transport", () => {
  it("exposes explicit thread-control tools", async () => {
    const result = await exchange([frame(1, "initialize"), frame(2, "tools/list")]);
    const names = result[1].result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "rivet_flag_unread", "rivet_steer_now", "rivet_run_routine_now", "rivet_stop_subagent",
    ]));
  });
  it("negotiates, lists schemas, ignores notifications and keeps stdout as JSON", async () => {
    const r = await exchange([frame(1, "initialize", { protocolVersion: "2024-11-05" }), { jsonrpc: "2.0", method: "notifications/initialized" }, frame(2, "tools/list"), frame(3, "ping")]);
    expect(r).toHaveLength(3);
    expect(r[0].result.protocolVersion).toBe("2024-11-05");
    expect(r[1].result.tools.map((t: any) => t.name)).toContain("rivet_spawn");
    expect(r[1].result.tools.every((t: any) => t.inputSchema.additionalProperties === false)).toBe(true);
    expect(r[2].result).toEqual({});
  });
  it("rejects malformed requests and invalid arguments without invoking operations", async () => {
    let calls = 0;
    const r = await exchange(["{", [], frame(0, "tools/list"), frame(1, "initialize"), frame(2, "missing"), ...[
      { name: "rivet_spawn", arguments: { task: 3 } },
      { name: "rivet_review_submit", arguments: {verdict:"approved",summary:"fine",comments:[{path:"x",line:0,body:"invalid"}]} },
      { name: "rivet_report", arguments: { kind: "done", note: "ok", sessionId: "other-agent" } },
      { name: "rivet_read", arguments: { run: "../other", limit: 10000 } },
      { name: "rivet_answer", arguments: { run: "r1", choice: "anything" } },
      { name: "rivet_delegate", arguments: {} },
    ].map((p, i) => frame(i + 3, "tools/call", p))], async () => { calls++; });
    expect(calls).toBe(0);
    expect(r[0].error.code).toBe(-32700);
    expect(r[1].error.code).toBe(-32600);
    expect(r[2].error.message).toBe("initialize first");
    expect(r.slice(5).every((m) => m.result.isError)).toBe(true);
  });
  it("takes status for kind in a report, as agents send before loading its schema", async () => {
    const seen: unknown[] = [];
    const r = await exchange([frame(1, "initialize"), frame(2, "tools/call", { name: "rivet_report", arguments: { status: "done", note: "ok" } })],
      async (_name, args) => { seen.push(args); return {}; });
    expect(r[1].result.isError).toBeFalsy();
    expect(seen).toEqual([{ kind: "done", note: "ok" }]);
  });
  it("cancels a waiting tool call by request id", async () => {
    const input = new PassThrough(); const replies: any[] = [];
    const served = serveMcp(input, (line) => replies.push(JSON.parse(line)), async (_name, _args, signal) => {
      signal!.throwIfAborted();
      await new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    input.write(JSON.stringify(frame(1, "initialize")) + "\n");
    input.write(JSON.stringify(frame(2, "tools/call", { name: "rivet_wait", arguments: { run: "r1" } })) + "\n");
    await new Promise((resolve) => setImmediate(resolve));
    input.end(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } }) + "\n");
    await served;
    expect(replies.find((r) => r.id === 2).result).toMatchObject({ isError: true, content: [{ type: "text", text: "cancelled" }] });
  });
  it("allows a short call to finish while a long call is pending", async () => {
    const input = new PassThrough(); const replies: any[] = [];
    let finish!: () => void;
    const waiting = new Promise<void>((r) => { finish = r; });
    const served = serveMcp(input, (s) => replies.push(JSON.parse(s)), async (name) => { if (name === "rivet_check") await waiting; return {}; });
    input.write(JSON.stringify(frame(1, "initialize")) + "\n");
    input.write(JSON.stringify(frame(2, "tools/call", { name: "rivet_check" })) + "\n");
    input.write(JSON.stringify(frame(3, "tools/call", { name: "rivet_status" })) + "\n");
    await new Promise((r) => setImmediate(r));
    expect(replies.map((m) => m.id)).toEqual([1, 3]);
    finish(); input.end(); await served;
    expect(replies.at(-1).id).toBe(2);
  });
});

it("runs the built bridge against a real daemon and preserves message text and caller identity", async () => {
  data = await makeDataDir();
  const runFile = join(data, "running.json");
  const store = openStore(data);
  store.saveRun(sessionRun(data));
  store.addTimeline("r1", "agent", [{ kind: "assistant", text: "history is data" }]);
  store.close();
  daemon = await startDaemon({ data, runFile, port: 0 });
  const env = { ...process.env, RIVET_RUN_FILE: runFile, RIVET_SESSION_ID: "r1-agent" };
  const child = spawn(process.execPath, [main, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (b) => { stdout += b; }); child.stderr.on("data", (b) => { stderr += b; });
  const done = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  const message = 'Keep "quotes", $(), backticks ` and\nnewlines exactly';
  for (const m of [frame(1, "initialize"), frame(2, "tools/call", { name: "rivet_send", arguments: { run: "r1", message, mode: "queue" } }), frame(3, "tools/call", { name: "rivet_read", arguments: { run: "r1" } }), frame(4, "tools/call", { name: "rivet_status", arguments: { run: "missing" } })]) child.stdin.write(JSON.stringify(m) + "\n");
  child.stdin.end();
  expect(await done, stderr).toBe(0);
  const replies = stdout.trim().split("\n").map((l) => JSON.parse(l));
  expect(replies.find((m) => m.id === 2).result.isError).toBeUndefined();
  expect(JSON.parse(replies.find((m) => m.id === 3).result.content[0].text).untrusted).toBe(true);
  expect(replies.find((m) => m.id === 4).result.isError).toBe(true);
  const saved = openStore(data);
  try { expect(saved.undeliveredMessages("r1", "agent")[0]?.message).toBe(message); } finally { saved.close(); }
  expect(() => toolCaller({}, data!)).toThrow("launched Rivet session");
});

it.each(["claude", "codex"] as const)("registers the bridge in %s start and resume", async (agent) => {
  const env = { RIVET_SESSION_ID: "r1-agent", RIVET_RUN_FILE: "test-run-file", RIVET_TEST_MCP: "1", RIVET_CHAT_COMMAND: JSON.stringify([process.execPath, fileURLToPath(new URL("./fake-chat-agent.mjs", import.meta.url)), agent === "claude" ? "acp" : "codex"]) };
  const cfg = mcpLaunch(env);
  expect(cfg.args.at(-1)).toBe("mcp");
  expect(cfg.env.RIVET_CHAT_COMMAND).toBeUndefined();
  for (const resume of [undefined, "existing"]) {
    const driver = (agent === "claude" ? claudeChat : codexChat)({ binary: "unused", cwd: process.cwd(), permission: "edits", env, resume, emit() {}, decide() { return undefined; } });
    try { await driver.start(); } finally { driver.close(); await driver.exited; }
  }
});
