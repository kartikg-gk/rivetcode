import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/agents/agent.js";
import { allowed, autoApproved } from "../src/chat/host.js";
import { runCli } from "../src/cli/commands.js";
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
  delete process.env.RIVET_TEST_STREAM_GATE;
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

describe("a chat session's own tools", () => {
  it("are covered by the rivet rule, and other tools are not", () => {
    expect(autoApproved(["Bash(rivet:*)"], { tool: "mcp__rivet__rivet_report" })).toBe(true);
    expect(autoApproved(["Bash(git:*)"], { tool: "mcp__rivet__rivet_report" })).toBe(false);
    expect(autoApproved(["Bash(rivet:*)"], { tool: "mcp__other__delete" })).toBe(false);
    expect(autoApproved(["Bash(rivet:*)"], { tool: "Bash", command: "rivet status" })).toBe(true);
  });
});

it("cancels an advertised Claude child session without cancelling the parent", async () => {
  process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, FAKE, "acp"]);
  daemon = await startDaemon({ data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500,
    agents: name => ({ ...getAgent("fake"), name, binary: "unused" }) });
  await api("PUT", `/api/v1/projects/${encodeURIComponent(project())}/config`, { key: "session.mode", value: "chat" });
  const id = (await api("POST", "/api/v1/runs", { repo, task: "CHILD_STOP_PROBE", agent: "claude" })).json.runId;
  await until("the active child", async () => (await timeline(id)).some(item => item.text.includes("test-child: running")));
  const request = await api("POST", `/api/v1/runs/${id}/stop-subagent`, { id: "test-child" });
  expect(request.status).toBe(202);
  await until("the cancelled child", async () => (await timeline(id)).some(item => item.text.includes("test-child: idle")));
  await until("the intact parent reply", async () => said(await timeline(id), "CHILD_STOP_PROBE"));
  const sent = await api("POST", `/api/v1/sessions/${id}-agent/send`, {
    message: "inspect this", mode: "queue", attachments: [{ name: "../sample.txt", base64: Buffer.from("attached bytes").toString("base64") }],
  });
  expect(sent.status).toBe(202);
  const directory = join(data, "attachments", id);
  const [file] = await readdir(directory);
  expect(file).toMatch(/sample\.txt$/);
  expect(await readFile(join(directory, file!), "utf8")).toBe("attached bytes");
  await until("attachment in provider prompt", async () => said(await timeline(id), file!));
  expect((await api("POST", `/api/v1/sessions/${id}-agent/send`, {
    message: "invalid", attachments: [{ name: "bad.txt", base64: "%%%" }],
  })).status).toBe(400);
  expect(await readdir(directory)).toEqual([file]);
});

describe("what a chat host could not report", () => {
  it("is replayed by the next host", async () => {
    process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, FAKE, "acp"]);
    daemon = await startDaemon({ data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500, agents: (name) => ({ ...getAgent("fake"), name, binary: "unused" }) });
    await api("PUT", `/api/v1/projects/${encodeURIComponent(project())}/config`, { key: "session.mode", value: "chat" });
    const runId = (await api("POST", "/api/v1/runs", { repo, task: "first", agent: "claude" })).json.runId as string;
    await until("idle", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "idle" && said(await timeline(runId), "echo: "));
    await api("POST", `/api/v1/sessions/${runId}-agent/stop`);
    await mkdir(join(data, "chat-journal"), { recursive: true });
    const lost = { batchId: "lost-1", events: [{ type: "message", itemId: "lost", role: "assistant", text: "said before the crash" }], raw: [], accepted: [] };
    await writeFile(join(data, "chat-journal", `${runId}-agent.jsonl`), JSON.stringify(lost) + "\n");
    await api("POST", `/api/v1/runs/${runId}/resume`, {});
    await until("the replayed reply", async () => said(await timeline(runId), "said before the crash"));
    await until("the journal to clear", async () => !existsSync(join(data, "chat-journal", `${runId}-agent.jsonl`)));
  }, 30_000);
});

describe("forking a Claude chat", () => {
  it("is native at the reply when the adapter can, with no context pasted in", async () => {
    process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, FAKE, "acp"]);
    process.env.FAKE_NATIVE_FORK = "1";
    try {
      daemon = await startDaemon({ data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500, agents: (name) => ({ ...getAgent("fake"), name, binary: "unused" }) });
      await api("PUT", `/api/v1/projects/${encodeURIComponent(project())}/config`, { key: "session.mode", value: "chat" });
      const runId = (await api("POST", "/api/v1/runs", { repo, task: "first", agent: "claude" })).json.runId as string;
      await until("idle", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "idle" && said(await timeline(runId), "echo: "));
      const fork = (await api("POST", `/api/v1/runs/${runId}/fork`, {})).json.runId as string;
      await api("POST", `/api/v1/sessions/${fork}-agent/send`, { message: "from the fork", mode: "queue" });
      await until("the fork's reply", async () => (await timeline(fork) as (Item & { agentChatId?: string })[]).some((i) => i.kind === "assistant" && i.text.startsWith("echo: from the fork") && i.agentChatId === "forked" && !i.text.includes("Inherited context")));
    } finally { delete process.env.FAKE_NATIVE_FORK; }
  }, 30_000);
});

describe("a chat worker whose agent refuses its turn", () => {
  it("escalates with the agent's own reason", async () => {
    process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, FAKE, "codex"]);
    daemon = await startDaemon({ data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500, agents: (name) => ({ ...getAgent("fake"), name, binary: "unused" }) });
    await api("PUT", `/api/v1/projects/${encodeURIComponent(project())}/config`, { key: "session.mode", value: "chat" });
    const runId = (await api("POST", "/api/v1/runs", { repo, task: "LIMITFAIL", agent: "codex" })).json.runId as string;
    const run = await until("escalation", async () => { const r = (await api("GET", `/api/v1/runs/${runId}`)).json.run; return r.node.status === "escalated" && r; });
    expect(run.node.summary).toBe("codex failed: You've hit your usage limit.");
  }, 30_000);
});

describe.each([["claude", "acp"], ["codex", "codex"]] as const)("a %s chat session", (agent, protocol) => {
  it("keeps its conversation, takes messages in each mode, and asks Rivet before what it may not run", async () => {
    process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, FAKE, protocol]);
    const streamGate = join(data, "stream-observed");
    process.env.RIVET_TEST_STREAM_GATE = streamGate;
    daemon = await startDaemon({
      data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500,
      agents: (name) => ({ ...getAgent("fake"), name, binary: "unused" }),
    });
    await api("PUT", `/api/v1/projects/${encodeURIComponent(project())}/config`, { key: "session.mode", value: "chat" });
    const runId = (await api("POST", "/api/v1/runs", { repo, task: "say hello", agent })).json.runId as string;
    // Watched from the start: a reply shows while it is still being written.
    let sawStreaming = false;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const t = await timeline(runId).catch(() => [] as Item[]);
        if (!sawStreaming && t.some((i) => (i as Item & { streaming?: boolean }).streaming && i.text === "echo: ")) {
          sawStreaming = true;
          await writeFile(streamGate, "observed");
        }
        await new Promise((r) => setTimeout(r, 30));
      }
    })();

    // Its first turn: the task, the command it ran with its output, and its reply.
    let items = await until("the first reply", async () => { const t = await timeline(runId); return said(t, "echo: ") && t; });
    expect(items[0]).toMatchObject({ kind: "prompt" });
    expect(items[0]!.text).toContain("say hello");
    expect(items.find((i) => i.kind === "tool")).toMatchObject({ text: "ls\na.txt" });
    const run = (await api("GET", `/api/v1/runs/${runId}`)).json;
    expect(run.run.node.runMode).toBe("chat");
    await until("idle", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "idle");
    watching = false;
    await watcher;
    expect(sawStreaming).toBe(true);
    items = await timeline(runId);
    expect(items.filter((i) => i.kind === "assistant").every((i) => !(i as Item & { streaming?: boolean }).streaming)).toBe(true);
    // Token use and context as the agent reported them.
    const usage = (await api("GET", `/api/v1/runs/${runId}`)).json.chatUsage;
    expect(usage).toMatchObject({ input: 100, output: 50, total: 150, contextUsed: 1000, contextWindow: 200000 });
    // The agent's own lines, kept as they came.
    const raw = (await api("GET", `/api/v1/runs/${runId}/provider-events?limit=1000`)).json.lines as { method: string; payload: string }[];
    expect(raw.some((l) => l.method === (protocol === "acp" ? "session/update" : "turn/completed"))).toBe(true);
    expect(raw.some((l) => l.method === "result")).toBe(true);

    // A queued message is the next turn; a command it may run is not asked about.
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "RIVET check", mode: "queue" });
    await until("the queued turn", async () => said(await timeline(runId), "echo: RIVET check"));
    await until("the queued turn finishing", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "idle");

    // A steer joins the turn in progress.
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "SLOW work", mode: "queue" });
    await until("the slow turn", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "busy");
    const queued = await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "also this", mode: "queue" });
    expect(queued.status).toBe(202);
    const promoted = await api("PATCH", `/api/v1/sessions/${runId}-agent/queue/${queued.json.id}`, { mode: "steer" });
    expect(promoted.status).toBe(200);
    await until("the steered reply", async () => said(await timeline(runId), "echo: SLOW work + also this"));

    // What it may not run waits for rivet answer; a no with a note becomes its next message.
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "ASK first", mode: "queue" });
    const blocked = await until("the question", async () => { const r = (await api("GET", `/api/v1/runs/${runId}`)).json; return r.run.node.activity === "approval" && r; });
    expect(blocked.pendingRequest).toMatchObject({ detail: "npm publish" });
    expect((await api("POST", `/api/v1/runs/${runId}/answer`, { choice: "no", note: "do not publish" })).status).toBeLessThan(300);
    items = await until("the answered turn", async () => { const t = await timeline(runId); return said(t, "do not publish") && t; });
    expect(said(items, "echo: ASK first (declined)")).toBe(true);
    expect(items.some((i) => i.kind === "event" && i.text.startsWith("asked to use") && i.text.includes("npm publish"))).toBe(true);
    expect(items.some((i) => i.kind === "message" && i.text === "also this")).toBe(true);

    // An interrupt stops the turn in progress and comes next.
    await until("idle again", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "idle");
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "SLOW long job", mode: "queue" });
    await until("the long turn", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.run.node.activity === "busy");
    await api("POST", `/api/v1/sessions/${runId}-agent/send`, { message: "stop and do this", mode: "interrupt" });
    items = await until("the interrupting turn", async () => { const t = await timeline(runId); return said(t, "echo: stop and do this") && t; });
    const order = items.filter((i) => i.kind === "assistant").map((i) => i.text);
    expect(order.indexOf("echo: stop and do this")).toBeGreaterThan(order.indexOf("echo: SLOW long job"));
    // Its totals keep counting.
    expect((await api("GET", `/api/v1/runs/${runId}`)).json.chatUsage.total).toBeGreaterThan(150);
    // rivet read --follow prints the conversation and ends when the session does.
    await api("POST", `/api/v1/sessions/${runId}-agent/stop`);
    const lines: string[] = [];
    const io = { env: { RIVET_RUN_FILE: join(data, "running.json"), RIVET_DATA_DIR: data, RIVET_NO_AUTOSTART: "1" }, cwd: repo, readStdin: async () => "", out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    expect(await runCli(["read", runId, "--follow"], io)).toBe(0);
    expect(lines.some((l) => l.includes("agent: echo: stop and do this"))).toBe(true);
    expect(lines.at(-1)).toBe("--- end of record ---");
    // The messages view leaves out commands and questions.
    const messages = (await api("GET", `/api/v1/runs/${runId}/timeline?limit=100`)).json.items as Item[];
    expect(messages.every((i) => ["prompt", "message", "assistant"].includes(i.kind))).toBe(true);
  }, 60_000);
});


describe.each([["claude", "acp"], ["codex", "codex"]] as const)("finishing a %s chat worker", (agent, protocol) => {
  it("flushes the final reply and receipt before stopping after a done report", async () => {
    process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, FAKE, protocol]);
    daemon = await startDaemon({data, runFile:join(data,"running.json"), port:0, agents:name=>({...getAgent("fake"),name,binary:"unused"})});
    await api("PUT", `/api/v1/projects/${encodeURIComponent(project())}/config`, {key:"session.mode",value:"chat"});
    const runId=(await api("POST","/api/v1/runs",{repo,task:"initial",agent})).json.runId;
    await until("initial idle",async()=>(await api("GET",`/api/v1/runs/${runId}`)).json.run.node.activity==="idle" && (await timeline(runId)).some(i=>i.kind==="assistant" && !(i as Item & {streaming?:boolean}).streaming));
    await api("POST",`/api/v1/sessions/${runId}-agent/send`,{message:"SLOW final receipt marker",mode:"queue"});
    await until("active final turn",async()=>(await api("GET",`/api/v1/runs/${runId}`)).json.run.node.activity==="busy");
    expect((await api("POST","/api/v1/reports",{sessionId:`${runId}-agent`,kind:"done",message:"finished"})).status).toBeLessThan(300);
    await until("done",async()=>(await api("GET",`/api/v1/runs/${runId}`)).json.run.node.status==="done");
    const final=await timeline(runId);
    expect(final.filter(i=>i.kind==="assistant"&&i.text==="echo: SLOW final receipt marker")).toHaveLength(1);
    expect(final.filter(i=>i.kind==="message"&&i.text==="SLOW final receipt marker")).toHaveLength(1);
    expect(final.some(i=>i.text.includes("Messages arrived while you worked"))).toBe(false);
  },30000);
});


it("escalates a timed-out completion without publishing or replaying consumed guidance",async()=>{
 process.env.RIVET_CHAT_COMMAND=JSON.stringify([process.execPath,FAKE,"acp"]);daemon=await startDaemon({data,runFile:join(data,"running.json"),port:0,agents:name=>({...getAgent("fake"),name,binary:"unused"})});await api("PUT",`/api/v1/projects/${encodeURIComponent(project())}/config`,{key:"session.mode",value:"chat"});const id=(await api("POST","/api/v1/runs",{repo,agent:"claude",task:"SLOW DRAIN_TIMEOUT incomplete task"})).json.runId;await until("busy",async()=>(await api("GET",`/api/v1/runs/${id}`)).json.run.node.activity==="busy");await api("POST","/api/v1/reports",{sessionId:id+"-agent",kind:"done",message:"reported early"});await until("uncertain completion",async()=>(await api("GET",`/api/v1/runs/${id}`)).json.run.node.status==="escalated",22000);expect((await api("GET",`/api/v1/runs/${id}`)).json.pr).toBeNull();expect((await timeline(id)).some(i=>i.text.includes("Messages arrived while you worked"))).toBe(false);
},30000);

describe("a delta chat session", () => {
  it("runs as a chat whatever the session mode, and asks Rivet before a command", async () => {
    process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, fileURLToPath(new URL("./fake-delta-agent.mjs", import.meta.url))]);
    daemon = await startDaemon({ data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500, agents: (name) => ({ ...getAgent("fake"), name, binary: "unused" }) });
    const runId = (await api("POST", "/api/v1/runs", { repo, task: "RUN it", agent: "delta", model: "openai/gpt-5-mini" })).json.runId as string;
    await until("the question", async () => (await api("GET", `/api/v1/runs/${runId}`)).json.pendingRequest?.tool === "Bash");
    expect((await api("GET", `/api/v1/runs/${runId}`)).json.run.node.runMode).toBe("chat");
    await api("POST", `/api/v1/runs/${runId}/answer`, { choice: "yes" });
    await until("the reply", async () => said(await timeline(runId), "echo: Your task: RUN it"));
    const items = await timeline(runId);
    expect(items.some((i) => i.kind === "tool" && i.text.includes("published"))).toBe(true);
    expect((await api("GET", `/api/v1/runs/${runId}`)).json.chatUsage).toMatchObject({ total: 12, contextUsed: 12, contextWindow: 1000 });
  }, 30_000);
});

describe("a delta model name", () => {
  it("splits into provider and model", async () => {
    const { deltaModel } = await import("../src/chat/drivers.js");
    expect(deltaModel("openai/gpt-5-mini")).toEqual({ provider: "openai", model: "gpt-5-mini" });
    expect(deltaModel("gpt-5")).toEqual({ model: "gpt-5" });
    expect(deltaModel("openrouter/meta/llama")).toEqual({ provider: "openrouter", model: "meta/llama" });
    expect(deltaModel(undefined)).toEqual({});
  });
});

describe("Rivet's own tools in a delta session", () => {
  it("are answered by Rivet when delta calls them", async () => {
    process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, fileURLToPath(new URL("./fake-delta-agent.mjs", import.meta.url))]);
    daemon = await startDaemon({ data, runFile: join(data, "running.json"), port: 0, stopGraceMs: 500, agents: (name) => ({ ...getAgent("fake"), name, binary: "unused" }) });
    const runId = (await api("POST", "/api/v1/runs", { repo, task: "TOOL please", agent: "delta" })).json.runId as string;
    await until("the reply", async () => said(await timeline(runId), "tool said: {"));
  }, 30_000);
});
