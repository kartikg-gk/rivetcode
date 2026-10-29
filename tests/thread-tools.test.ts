import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { forkConversation, mergeConversation } from "../src/scheduler/conversations.js";
import { waitForRun, type WaitSnapshot } from "../src/scheduler/wait.js";
import { openStore, type Store } from "../src/store.js";
import { cleanupResult, makeDataDir, makeRepo, removeRepo, sessionRun } from "./helpers.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { getAgent } from "../src/agents/agent.js";
import { claudeChat, codexChat, type ChatEvent } from "../src/chat/drivers.js";
import { toolCaller } from "../src/mcp/server.js";
import { workerPrompt } from "../src/scheduler/prompts.js";
import { runCli, type CliIo } from "../src/cli/commands.js";

let data: string | undefined; let repo: string | undefined; let store: Store | undefined; let daemon: Daemon | undefined;
afterEach(async () => { await daemon?.stop(); daemon = undefined; store?.close(); store = undefined; delete process.env.RIVET_CHAT_COMMAND; if (data) await removeRepo(data); if (repo) await removeRepo(repo); data = repo = undefined; });
beforeAll(() => { execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.build.json"], { cwd: fileURLToPath(new URL("..", import.meta.url)) }); }, 120000);
function exchange(s: Store, id: string, turn: string, text: string) {
  s.recordChat(id, "agent", [
    { type: "turn", turnId: turn, state: "running" },
    { type: "message", itemId: `${turn}-u`, role: "user", text: `question ${text}`, turnId: turn },
    { type: "message", itemId: `${turn}-a`, role: "assistant", text, turnId: turn },
    { type: "turn", turnId: turn, state: "completed" },
  ]);
}
async function seed() {
  data = await makeDataDir(); store = openStore(data);
  const run = sessionRun(data, { agent: "codex" }); run.node.sessionMode = "chat";
  store.saveRun(run); store.recordChat("r1", "agent", [{ type: "conversation", id: "native-parent" }]);
  exchange(store, "r1", "t1", "original marker");
  return store;
}

describe("durable conversation lineage", () => {
  it("pins inherited history, preserves ancestry after reopening, and shares only the checkout", async () => {
    const s = await seed();
    exchange(s, "r1", "t2", "later marker");
    const child = forkConversation(s, "r1", { at: 2 });
    const run = s.loadRun(child.runId);
    expect(run.node.worktree).toBe(s.loadRun("r1").node.worktree);
    expect(workerPrompt(run)).toContain("share the checkout");
    expect(run.sharedWorkspace).toBe("r1"); expect(run.node.providerConversationId).toBeUndefined();
    expect(run.node.status).toBe("pending");
    exchange(s, "r1", "later-turn", "future marker");
    expect(s.readChat(child.runId, { limit: 100 }).items.map((i) => i.text)).toEqual(["question original marker", "original marker"]);
    expect(s.readChat(child.runId, { after: 1, limit: 1 }).items[0].position).toBe(2);
    s.close(); store = openStore(data!);
    expect(store.getFork(child.runId)?.providerTurn).toBe("t1");
    expect(store.getFork(child.runId)?.providerId).toBe("native-parent");
    exchange(store, child.runId, "c1", "child finding");
    expect(store.readChat(child.runId, { limit: 100 }).items.map((i) => i.position)).toEqual([1, 2, 3, 4]);
    expect(store.readEvents(child.runId, { limit: 100 }).some((e) => e.type === "conversation.forked")).toBe(true);
    expect(store.workspaceForks("r1")).toContain(child.runId);
    store.detachFork(child.runId); expect(store.workspaceForks("r1")).not.toContain(child.runId);
  });
  it("expires only finished fork snapshots in the selected project and preserves lineage", async () => {
    const s = await seed();
    const active = forkConversation(s, "r1", {});
    const expired = forkConversation(s, "r1", {});
    const recent = forkConversation(s, "r1", {});
    const boundary = forkConversation(s, "r1", {});
    const staleRunning = forkConversation(s, "r1", {});
    s.updateNode(expired.runId, "agent", { status: "done", finishedAt: "2000-01-01T00:00:00.000Z" });
    s.updateNode(recent.runId, "agent", { status: "done", finishedAt: "2002-01-01T00:00:00.000Z" });
    s.updateNode(boundary.runId, "agent", { status: "done", finishedAt: "2001-01-01T00:00:00.000Z" });
    s.updateNode(staleRunning.runId, "agent", { status: "running", finishedAt: "2000-01-01T00:00:00.000Z" });
    const other = sessionRun(data!, { id: "r2", project: "other", agent: "codex" }); other.node.sessionMode = "chat";
    s.saveRun(other); exchange(s, "r2", "other-turn", "other project");
    const otherFork = forkConversation(s, "r2", {});
    s.updateNode(otherFork.runId, "agent", { status: "done", finishedAt: "2000-01-01T00:00:00.000Z" });
    s.updateNode("r1", "agent", { status: "done", finishedAt: "2000-01-01T00:00:00.000Z" });
    s.pruneTimeline("proj", "2001-01-01T00:00:00.000Z");
    expect(s.readChat("r1", { limit: 100 }).items).toEqual([]);
    expect(s.getFork(expired.runId)).toMatchObject({ sourceRun: "r1", rootRun: "r1", position: 2, providerId: "native-parent", items: [] });
    for (const f of [active, recent, boundary, staleRunning, otherFork]) expect(s.getFork(f.runId)?.items).toHaveLength(2);
    s.close(); store = openStore(data!);
    expect(store.getFork(expired.runId)?.items).toEqual([]);
    expect(store.workspaceForks("r1")).toContain(expired.runId);
    expect(store.readChat(active.runId, { limit: 100 }).items).toHaveLength(2);
  });
  it("honors forever and applies a changed retention setting on the daemon's next sweep", async () => {
    const s = await seed(); const child = forkConversation(s, "r1", {});
    s.updateNode(child.runId, "agent", { status: "done", finishedAt: "2000-01-01T00:00:00.000Z" });
    s.setConfig("proj", "timeline.keep", "forever"); s.close(); store = undefined;
    daemon = await startDaemon({ data: data!, runFile: join(data!, "running.json"), port: 0, pruneMs: 10 });
    store = openStore(data!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.getFork(child.runId)?.items).toHaveLength(2);
    store.setConfig("proj", "timeline.keep", "0");
    const end = Date.now() + 2000;
    while (store.getFork(child.runId)?.items.length) {
      if (Date.now() > end) throw new Error("snapshot retention sweep did not run");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(store.getFork(child.runId)).toMatchObject({ sourceRun: "r1", position: 2, items: [] });
  });
  it("transfers only new exploration, deduplicates retries and refuses unrelated targets", async () => {
    const s = await seed(); const child = forkConversation(s, "r1", {});
    exchange(s, child.runId, "c1", "first finding");
    const first = mergeConversation(s, child.runId);
    expect(mergeConversation(s, child.runId)).toMatchObject({ id: first.id, duplicate: true });
    expect(s.undeliveredMessages("r1", "agent")).toHaveLength(0);
    s.queueMessage("r1", "agent", "continue with this exploration");
    expect(s.undeliveredMessages("r1", "agent")).toHaveLength(1);
    expect(s.undeliveredMessages("r1", "agent")[0].message).toContain("first finding");
    expect(s.undeliveredMessages("r1", "agent")[0].message).not.toContain("original marker");
    exchange(s, child.runId, "c2", "second finding"); mergeConversation(s, child.runId);
    s.queueMessage("r1", "agent", "continue again");
    const next = s.undeliveredMessages("r1", "agent")[1].message;
    expect(next).toContain("second finding"); expect(next).not.toContain("first finding");
    s.saveRun(sessionRun(data!, { id: "r2" }));
    expect(() => mergeConversation(s, child.runId, "r2")).toThrow("ancestor");
    expect(() => forkConversation(s, "r1", { at: 1 })).toThrow("completed assistant");
  });
  it("searches metadata, chat and terminal messages, with project scope and redaction", async () => {
    const s = await seed();
    s.saveRun(sessionRun(data!, { id: "r2", project: "elsewhere", task: "billing migration" }));
    s.addTimeline("r2", "agent", [{ kind: "assistant", text: "terminal marker" }]);
    expect(s.searchRuns("billing", { limit: 10 })[0]).toMatchObject({ runId: "r2", source: "metadata" });
    expect(s.searchRuns("billing", { project: "proj", limit: 10 })).toEqual([]);
    expect(s.searchRuns("original marker", { project: "proj", limit: 1 })).toHaveLength(1);
    expect(s.searchRuns("terminal marker", { limit: 10 })[0]).toMatchObject({ runId: "r2", source: "assistant" });
    s.recordChat("r1", "agent", [{ type: "message", itemId: "stream", role: "assistant", text: "unfinished needle", streaming: true }]);
    expect(s.searchRuns("unfinished needle", { limit: 10 })).toEqual([]);
    s.recordChat("r1", "agent", [{ type: "message", itemId: "stream", role: "assistant", text: "finished needle", streaming: false }]);
    expect(s.searchRuns("finished needle", { limit: 10 })).toHaveLength(1);
    expect(s.searchRuns("unfinished needle", { limit: 10 })).toEqual([]);
    expect(s.searchRuns("ma", { limit: 10 }).length).toBeGreaterThan(0);
    expect(s.searchRuns("' OR 1=1 --", { limit: 10 })).toEqual([]);
  });
});

describe("completion waits", () => {
  const signal = () => new AbortController().signal;
  it("returns already completed work immediately, and distinguishes turn from task", async () => {
    const read = async (): Promise<WaitSnapshot> => ({ status: "running", activity: "idle", live: true, turn: { id: "t1", state: "completed" } });
    expect(await waitForRun(read, { scope: "turn", timeoutMs: 0 }, signal())).toMatchObject({ timedOut: false, turnId: "t1" });
    expect(await waitForRun(read, { scope: "task", timeoutMs: 0 }, signal())).toMatchObject({ timedOut: true });
  });
  it("waits for startup instead of returning the preceding completed turn", async () => {
    let calls = 0;
    const result = await waitForRun(async () => ({ status: "running", live: true, pending: ++calls === 1, turn: { id: calls === 1 ? "old" : "new", state: "completed" } }), { scope: "turn", timeoutMs: 1000 }, signal());
    expect(result).toMatchObject({ turnId: "new", timedOut: false });
  });
  it("pins the selected turn, handles input requests, completion, restart and cancellation", async () => {
    let calls = 0;
    const result = await waitForRun(async (turn) => {
      calls++; if (calls > 1) expect(turn).toBe("t1");
      return { status: "running", live: true, turn: { id: "t1", state: calls > 1 ? "completed" : "running" }, pendingRequest: { tool: "shell", detail: "approval" } };
    }, { scope: "turn", timeoutMs: 1000 }, signal());
    expect(result.timedOut).toBe(false);
    expect(await waitForRun(async () => ({ status: "running", live: false, activity: "exited" }), { scope: "turn", timeoutMs: 100 }, signal())).toMatchObject({ timedOut: false });
    const abort = new AbortController();
    const waiting = waitForRun(async () => ({ status: "running", live: true, activity: "active" }), { scope: "task", timeoutMs: 60000 }, abort.signal);
    abort.abort(); await expect(waiting).rejects.toThrow();
  });
});

it.each([false, true])("initializes provider context lazily with native support unavailable=%s", async (unsupported) => {
  const events: ChatEvent[] = [];
  const driver = codexChat({ binary: "unused", cwd: process.cwd(), permission: "accept-edits", env: {
    RIVET_CHAT_COMMAND: JSON.stringify([process.execPath, fileURLToPath(new URL("./fake-chat-agent.mjs", import.meta.url)), "codex"]),
    ...(unsupported ? { RIVET_TEST_NO_FORK: "1" } : {}),
  }, fork: { providerId: "parent", turn: "t1", agent: "codex", context: "pinned old context" }, emit: (e) => events.push(e), decide() { return undefined; } });
  try { await driver.start(); await driver.prompt("explore"); }
  finally { driver.close(); await driver.exited; }
  expect(events.find((e) => e.type === "conversation")).toMatchObject({ forkStrategy: unsupported ? "reconstructed" : "native" });
  expect(events.filter((e) => e.type === "message").at(-1)).toMatchObject({ text: unsupported ? "echo: pinned old context\n\nexplore" : "echo: explore" });
});

it("reconstructs a pinned Claude prefix explicitly", async () => {
  const events: ChatEvent[] = [];
  const driver = claudeChat({ binary: "unused", cwd: process.cwd(), permission: "accept-edits", env: { RIVET_CHAT_COMMAND: JSON.stringify([process.execPath, fileURLToPath(new URL("./fake-chat-agent.mjs", import.meta.url)), "acp"]) }, fork: { providerId: "parent", agent: "claude", context: "pinned prefix" }, emit: (e) => events.push(e), decide() { return undefined; } });
  try { await driver.start(); await driver.prompt("new question"); } finally { driver.close(); await driver.exited; }
  expect(events.find((e) => e.type === "conversation")).toMatchObject({ forkStrategy: "reconstructed" });
  expect(events.filter((e) => e.type === "message").at(-1)).toMatchObject({ text: "echo: pinned prefix\n\nnew question" });
});

it("exposes lazy forks, search, wait and merge-back through daemon and CLI, protecting the shared checkout", async () => {
  const s = await seed(); repo = await makeRepo();
  const source = s.loadRun("r1"); source.node.worktree = repo; s.saveRun(source); s.close(); store = undefined;
  process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, fileURLToPath(new URL("./fake-chat-agent.mjs", import.meta.url)), "codex"]);
  daemon = await startDaemon({ data: data!, runFile: join(data!, "running.json"), port: 0, stopGraceMs: 500, agents: (name) => ({ ...getAgent("fake"), name, binary: "unused" }) });
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${daemon!.port}/api/v1${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await r.json() as any;
    if (path.endsWith("/clean") && r.status === 202) return { status: 200, value: await cleanupResult(`http://127.0.0.1:${daemon!.port}`, value.id) };
    return { status: r.status, value };
  };
  const out: string[] = [];
  const io: CliIo = { env: { RIVET_SESSION_ID: "r1-agent", RIVET_PROJECT_ID: "proj", RIVET_RUN_FILE: join(data!, "running.json") }, cwd: repo, readStdin: async () => "", out: (l) => out.push(l), err: (l) => { throw new Error(l); } };
  expect(await runCli(["fork", "r1", "--name", "exploration"], io)).toBe(0);
  const child = JSON.parse(out.pop()!).runId;
  expect((await api("GET", `/runs/${child}`)).value.live).toBe(false);
  expect((await api("POST", "/runs/r1/clean", {})).value.kept).toEqual(["agent"]);
  expect((await api("POST", `/sessions/${child}-agent/send`, { message: "new finding", mode: "queue" })).status).toBe(202);
  const end = Date.now() + 15000;
  while (true) {
    const r = await api("GET", `/runs/${child}/wait?scope=turn&timeoutMs=1000`);
    if (r.value.turn?.state === "completed") break;
    if (Date.now() > end) throw new Error("fork did not finish its first turn");
  }
  expect((await api("GET", `/runs/${child}`)).value.fork.strategy).toBe("native");
  expect(await runCli(["search", "new finding"], io)).toBe(0);
  expect(out.join("\n")).toContain(child);
  const tools = toolCaller(io.env, repo!);
  expect(await tools("rivet_search", { query: "new finding" })).toMatchObject({ matches: expect.arrayContaining([expect.objectContaining({ runId: child })]) });
  expect(await tools("rivet_wait", { run: child, timeoutMs: 0 })).toMatchObject({ timedOut: false });
  expect(await runCli(["merge-back", child], io)).toBe(0);
  expect(await tools("rivet_transfer", { action: "status", run: child })).toMatchObject({ transfers: [expect.objectContaining({ delivery: "pending" })] });
  expect((await api("POST", `/runs/${child}/merge-back`, {})).value.duplicate).toBe(true);
  expect((await api("POST", `/runs/${child}/clean`, {})).value.detached).toBe(true);
  expect((await api("POST", `/sessions/${child}-agent/send`, { message: "again" })).status).toBe(409);
  const waiting = api("GET", "/runs/r1/wait?scope=task&timeoutMs=60000");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await daemon.stop();
  expect((await waiting).status).toBe(503);
}, 30000);
