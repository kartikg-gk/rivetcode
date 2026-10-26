import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/agents/agent.js";
import { allowed } from "../src/chat/host.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { makeDataDir, makeRepo, removeRepo } from "./helpers.js";

const FAKE = fileURLToPath(new URL("./fake-chat-agent.mjs", import.meta.url));

describe("commands a chat session may run without asking", () => {
  it("matches permission rules by prefix or exactly", () => {
    const rules = ["Bash(rivet:*)", "Bash(git:*)", "Bash(npm test)"];
    expect(allowed(rules, "rivet status")).toBe(true);
    expect(allowed(rules, "git")).toBe(true);
    expect(allowed(rules, "gitk")).toBe(false);
    expect(allowed(rules, "npm test")).toBe(true);
    expect(allowed(rules, "npm test -- --watch")).toBe(false);
    expect(allowed(rules, "npm publish")).toBe(false);
    expect(allowed(rules, undefined)).toBe(false);
  });
});

let repo: string;
let data: string;
let daemon: Daemon | undefined;

// The host runs as its own process from the built CLI.
beforeAll(() => { execSync("npm run build", { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "ignore" }); }, 120_000);
beforeEach(async () => {
  repo = await makeRepo();
  data = await makeDataDir();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  delete process.env.RIVET_CHAT_COMMAND;
  await removeRepo(repo);
  await removeRepo(data);
});

const url = (path: string) => `http://127.0.0.1:${daemon!.port}${path}`;
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url(path), { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const project = () => repo.split(/[\\/]/).pop()!.toLowerCase().replace(/ /g, "-");
type Item = { kind: string; tool?: string; text: string };
const timeline = async (runId: string): Promise<Item[]> => (await api("GET", `/api/v1/runs/${runId}/timeline?view=activity&limit=100`)).json.items;
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const said = (items: Item[], text: string) => items.some((i) => i.kind === "assistant" && i.text.includes(text));

describe.each([["claude", "acp"], ["codex", "codex"]] as const)("a %s chat session", (agent, protocol) => {
  it("keeps its conversation, takes messages in each mode, and asks Rivet before what it may not run", async () => {
    process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, FAKE, protocol]);
    daemon = await startDaemon({
      data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500,
      agents: (name) => ({ ...getAgent("fake"), name, binary: "unused" }),
    });
    await api("PUT", `/api/v1/projects/${encodeURIComponent(project())}/config`, { key: "session.mode", value: "chat" });
    const runId = (await api("POST", "/api/v1/runs", { repo, task: "say hello", agent })).json.runId as string;

    // Its first turn: the task, the command it ran with its output, and its reply.
    let items = await until("the first reply", async () => { const t = await timeline(runId); return said(t, "echo: ") && t; });
    expect(items[0]).toMatchObject({ kind: "prompt" });
    expect(items[0]!.text).toContain("say hello");
    expect(items.find((i) => i.kind === "tool")).toMatchObject({ text: "ls\na.txt" });
    const run = (await api("GET", `/api/v1/runs/${runId}`)).json;
    expect(run.run.node.sessionMode).toBe("chat");
    await until("idle", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "idle");

    // A queued message is the next turn; a command it may run is not asked about.
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "RIVET check", mode: "queue" });
    await until("the queued turn", async () => said(await timeline(runId), "echo: RIVET check"));

    // A steer joins the turn in progress.
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "SLOW work", mode: "queue" });
    await until("the slow turn", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "active");
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "also this", mode: "steer" });
    await until("the steered reply", async () => said(await timeline(runId), "echo: SLOW work + also this"));

    // What it may not run waits for rivet answer; a no with a note becomes its next message.
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "ASK first", mode: "queue" });
    const blocked = await until("the question", async () => { const r = (await api("GET", `/api/v1/runs/${runId}`)).json; return r.run.node.activity === "blocked" && r; });
    expect(blocked.pendingRequest).toMatchObject({ detail: "npm publish" });
    expect((await api("POST", `/api/v1/runs/${runId}/answer`, { choice: "no", note: "do not publish" })).status).toBeLessThan(300);
    items = await until("the answered turn", async () => { const t = await timeline(runId); return said(t, "do not publish") && t; });
    expect(said(items, "echo: ASK first (declined)")).toBe(true);
    expect(items.some((i) => i.kind === "event" && i.text.startsWith("asked to use") && i.text.includes("npm publish"))).toBe(true);
    expect(items.some((i) => i.kind === "message" && i.text === "also this")).toBe(true);

    // An interrupt stops the turn in progress and comes next.
    await until("idle again", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "idle");
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "SLOW long job", mode: "queue" });
    await until("the long turn", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "active");
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "stop and do this", mode: "interrupt" });
    items = await until("the interrupting turn", async () => { const t = await timeline(runId); return said(t, "echo: stop and do this") && t; });
    const order = items.filter((i) => i.kind === "assistant").map((i) => i.text);
    expect(order.indexOf("echo: stop and do this")).toBeGreaterThan(order.indexOf("echo: SLOW long job"));
    // The messages view leaves out commands and questions.
    const messages = (await api("GET", `/api/v1/runs/${runId}/timeline?limit=100`)).json.items as Item[];
    expect(messages.every((i) => ["prompt", "message", "assistant"].includes(i.kind))).toBe(true);
  }, 60_000);
});
