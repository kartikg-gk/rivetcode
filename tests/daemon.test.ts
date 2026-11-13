import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { readRunFile, writeRunFile } from "../src/runfile.js";
import { openStore, type Run } from "../src/store.js";
import { makeDataDir, removeRepo, sessionRun } from "./helpers.js";

let data: string;
let runFile: string;
let daemon: Daemon | undefined;

beforeEach(async () => {
  data = await makeDataDir();
  runFile = join(data, "running.json");
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await removeRepo(data);
});

function run(): Run {
  return { ...sessionRun(data, { id: "r1", project: "proj", task: "task" }), repo: join(data, "repo") };
}

function seed(): void {
  const store = openStore(data);
  store.saveRun(run());
  store.close();
}

async function start(): Promise<Daemon> {
  daemon = await startDaemon({ data, runFile, port: 0 });
  return daemon;
}

function url(path: string): string {
  return `http://127.0.0.1:${daemon!.port}${path}`;
}

async function post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(url(path), {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function rows(sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(join(data, "rivet.db"));
  try { return db.prepare(sql).all() as Record<string, unknown>[]; }
  finally { db.close(); }
}

async function mockHealth(payload: unknown): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no mock port");
  return { port: address.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("daemon ownership and lifecycle", () => {
  it("refuses a second daemon when the recorded owner answers healthz", async () => {
    const first = await start();
    await expect(startDaemon({ data, runFile, port: 0 })).rejects.toThrow(
      `daemon already running (pid ${process.pid}, port ${first.port}); refusing to start`,
    );
  });

  it("overwrites a run file left by a dead pid", async () => {
    await writeRunFile(runFile, { pid: 2147483647, port: 49152, startedAt: new Date().toISOString() });
    const owner = await start();
    expect((await readRunFile(runFile))?.port).toBe(owner.port);
  });

  it("overwrites a live pid with no listening daemon", async () => {
    await writeRunFile(runFile, { pid: process.pid, port: 0, startedAt: new Date().toISOString() });
    await start();
    expect((await readRunFile(runFile))?.port).toBe(daemon!.port);
  });

  it.each([
    ["service", { status: "ok", service: "other", pid: process.pid }],
    ["pid", { status: "ok", service: "rivet-daemon", pid: process.pid + 1 }],
  ])("overwrites a listener with the wrong %s", async (_name, response) => {
    const mock = await mockHealth(response);
    try {
      await writeRunFile(runFile, { pid: process.pid, port: mock.port, startedAt: new Date().toISOString() });
      await start();
      expect((await readRunFile(runFile))?.port).toBe(daemon!.port);
    } finally { await mock.close(); }
  });

  it("records the bound port and removes its run file on stop", async () => {
    const owner = await start();
    expect(await readRunFile(runFile)).toMatchObject({ pid: process.pid, port: owner.port });
    await owner.stop();
    daemon = undefined;
    expect(await readRunFile(runFile)).toBeNull();
  });

  it("upgrades a version 1 database on startup", async () => {
    seed();
    const db = new DatabaseSync(join(data, "rivet.db"));
    db.exec("DROP TABLE lifecycle_state; DROP TABLE environment_preferences; DROP TABLE pr_links; DROP TABLE registered_projects; DROP TABLE review_notes; DROP TABLE run_organization; DROP TABLE recovery_journal; DROP TABLE conversation_branches; DROP TABLE wait_subscriptions; DROP TABLE chat_receipts; DROP TRIGGER chat_search_insert; DROP TRIGGER chat_search_update; DROP TRIGGER chat_search_delete; DROP TRIGGER timeline_search_insert; DROP TRIGGER timeline_search_delete; DROP TABLE chat_search; DROP TABLE timeline_search; DROP TABLE context_transfers; DROP TABLE thread_forks; ALTER TABLE chat_turns DROP COLUMN agent; DROP TABLE chat_raw; DROP TABLE chat_log; DROP TABLE chat_turns; DROP TABLE chat_sessions; ALTER TABLE nodes DROP COLUMN agent_chat_id; ALTER TABLE nodes DROP COLUMN run_mode; DROP TABLE events; DROP TABLE timeline; ALTER TABLE outbox DROP COLUMN mode; ALTER TABLE runs DROP COLUMN spec; DROP TABLE routine_runs; DROP TABLE routines; DROP TABLE snippets; DROP TABLE reviews; ALTER TABLE runs DROP COLUMN issue; ALTER TABLE runs DROP COLUMN role; ALTER TABLE runs DROP COLUMN name; ALTER TABLE runs DROP COLUMN orchestrator; ALTER TABLE runs DROP COLUMN model; ALTER TABLE nodes DROP COLUMN shared; DROP TABLE conversations; ALTER TABLE nodes DROP COLUMN started_at; ALTER TABLE nodes DROP COLUMN first_heard_at; DROP TABLE pull_requests; ALTER TABLE runs DROP COLUMN end_on_merge; DROP TABLE reports; DROP TABLE outbox; DROP TABLE project_config; ALTER TABLE nodes DROP COLUMN agent_own_id; ALTER TABLE nodes DROP COLUMN activity_at; ALTER TABLE nodes DROP COLUMN finished_at; DELETE FROM schema_migrations WHERE version >= 2");
    db.close();
    await start();
    expect(rows("SELECT version FROM schema_migrations ORDER BY version")).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }, { version: 19 }, { version: 20 }, { version: 21 }, { version: 22 }, { version: 23 }, { version: 24 }, { version: 25 }, { version: 26 }, { version: 27 }, { version: 28 }, { version: 29 }, { version: 30 }, { version: 31 }, { version: 32 }, { version: 33 }, { version: 34 }, { version: 35 }, { version: 36 },
    ]);
    expect(rows("SELECT id FROM nodes WHERE run_id = 'r1'")).toHaveLength(1);
  });

  it("keeps a successor's run file on stop", async () => {
    const owner = await start();
    await writeRunFile(runFile, { pid: process.pid + 1, port: 9999, startedAt: new Date().toISOString() });
    await owner.stop();
    daemon = undefined;
    expect((await readRunFile(runFile))?.pid).toBe(process.pid + 1);
  });

  it("restricts shutdown and closes after a successful reply", async () => {
    await start();
    const forbidden = await post("/shutdown", {}, { Origin: "https://evil.example" });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ status: "forbidden" });
    const accepted = await post("/shutdown", {});
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ status: "shutting_down", pid: process.pid });
    await daemon!.stop();
    daemon = undefined;
    await expect(fetch(`http://127.0.0.1:${new URL(accepted.url).port}/healthz`)).rejects.toThrow();
  });
});

describe("daemon routes", () => {
  beforeEach(async () => { seed(); await start(); });

  it("answers healthz and rejects unknown routes or methods", async () => {
    const health = await fetch(url("/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "rivet-daemon", pid: process.pid, version: expect.any(String) });
    expect((await fetch(url("/missing"))).status).toBe(404);
    expect((await post("/healthz", {})).status).toBe(405);
  });

  it("saves activity and an agent session id", async () => {
    const response = await post("/api/v1/sessions/r1-agent/activity", {
      state: "approval", agentOwnId: "agent-42",
    });
    expect(response.status).toBe(204);
    await daemon!.stop();
    daemon = undefined;
    const store = openStore(data);
    try {
      expect(store.loadRun("r1").node).toMatchObject({ activity: "approval", agentOwnId: "agent-42" });
    } finally { store.close(); }
  });

  it("rejects invalid activity, session ids, and unknown sessions", async () => {
    expect((await post("/api/v1/sessions/r1-agent/activity", { state: "asleep" })).status).toBe(400);
    expect((await post("/api/v1/sessions/bad/activity", { state: "busy" })).status).toBe(400);
    expect((await post("/api/v1/sessions/r1-missing/activity", { state: "busy" })).status).toBe(404);
  });

  it("stores reports without changing the session status", async () => {
    const response = await post("/api/v1/outcomes", { sessionId: "r1-agent", kind: "done", message: "ready" });
    expect(response.status).toBe(201);
    expect(await response.json()).toHaveProperty("id");
    await daemon!.stop();
    daemon = undefined;
    expect(rows("SELECT run_id, node_id, kind, message FROM reports")).toEqual([
      { run_id: "r1", node_id: "agent", kind: "done", message: "ready" },
    ]);
    expect(rows("SELECT status FROM nodes WHERE id = 'agent'")[0]).toEqual({ status: "pending" });
  });

  it("rejects invalid reports and unknown sessions", async () => {
    expect((await post("/api/v1/outcomes", { sessionId: "r1-agent", kind: "other" })).status).toBe(400);
    expect((await post("/api/v1/outcomes", { sessionId: "r1-missing", kind: "done" })).status).toBe(404);
  });

  it("queues messages for later delivery", async () => {
    const response = await post("/api/v1/sessions/r1-agent/send", { message: "hello", from: "root" });
    expect(response.status).toBe(202);
    expect(await response.json()).toHaveProperty("id");
    await daemon!.stop();
    daemon = undefined;
    expect(rows("SELECT run_id, node_id, from_session, message, delivered_at FROM outbox")).toEqual([
      { run_id: "r1", node_id: "agent", from_session: "root", message: "hello", delivered_at: null },
    ]);
  });

  it("rejects invalid messages and unknown sessions", async () => {
    expect((await post("/api/v1/sessions/r1-agent/send", {})).status).toBe(400);
    expect((await post("/api/v1/sessions/r1-missing/send", { message: "hi" })).status).toBe(404);
  });

  it("rejects invalid JSON and bodies above 1 MiB", async () => {
    for (const path of [
      "/api/v1/outcomes",
      "/api/v1/sessions/r1-agent/activity",
      "/api/v1/sessions/r1-agent/send",
    ]) {
      expect((await post(path, "{broken")).status).toBe(400);
      expect((await post(path, { message: "x".repeat(1024 * 1024) })).status).toBe(413);
    }
  });
});


it("pages an entire long item without skipping its tail and validates offsets",async()=>{
 const s=openStore(data);const r=run();r.node.runMode="chat";s.saveRun(r);const text="prefix "+"long history ".repeat(6000)+" UNIQUE_TAIL";s.recordChat("r1","agent",[{type:"message",itemId:"long",role:"assistant",text}]);const position=s.readChat("r1",{limit:1}).items[0]!.position;s.close();await start();
 let offset=0,recovered="";for(;;){const response=await fetch(url(`/api/v1/runs/r1/timeline?item=${position}&startChar=${offset}&charLimit=4000`));expect(response.status).toBe(200);const page=await response.json();const item=page.items[0];recovered+=item.text;if(item.continueFrom===null)break;expect(item.continueFrom).toBeGreaterThan(offset);offset=item.continueFrom;}expect(recovered).toBe(text);
 expect((await fetch(url("/api/v1/runs/r1/timeline?startChar=3"))).status).toBe(400);expect((await fetch(url("/api/v1/runs/r1/timeline?item=999"))).status).toBe(404);
});

it("holds interrupted native workers on restart without replaying their pending messages",async()=>{
 const s=openStore(data);const r=run();r.node.runMode="chat";r.node.status="running";r.node.attempts=1;r.node.agentChatId="saved-provider";s.saveRun(r);s.queueMessage("r1","agent","possibly consumed",undefined,"queue");s.close();await start();await daemon!.idle();const reopened=openStore(data);try{expect(reopened.loadRun("r1").node).toMatchObject({status:"escalated",summary:expect.stringContaining("uncertain")});expect(reopened.undeliveredMessages("r1","agent")).toHaveLength(1);}finally{reopened.close();}
});

it("runs, inspects and stops saved scripts while protecting their checkout", async () => {
  const fixture = run();
  await mkdir(fixture.node.worktree, { recursive: true });
  const store = openStore(data);
  store.saveRun(fixture);
  store.saveProject({ id: "proj", repo: fixture.repo, title: "Project", instructions: "", scripts: [
    { id: "watch", command: `"${process.execPath}" -e "console.log('script-ready'); setInterval(()=>{},1000)"` },
  ] });
  store.close();
  await start();
  expect((await post("/api/v1/runs/r1/scripts/watch", { confirm: "different" })).status).toBe(400);
  expect((await post("/api/v1/runs/r1/scripts/watch", { confirm: "watch" })).status).toBe(202);
  let output = "";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const response = await fetch(url("/api/v1/runs/r1/scripts"));
    const result = await response.json() as { running: { output: string } };
    output = result.running.output;
    if (output.includes("script-ready")) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect(output).toContain("script-ready");
  expect((await post("/api/v1/runs/r1/clean", {})).status).toBe(409);
  expect((await fetch(url("/api/v1/runs/r1/scripts"), { method: "DELETE" })).status).toBe(204);
  const result = await (await fetch(url("/api/v1/runs/r1/scripts"))).json() as { running: { alive: boolean } };
  expect(result.running.alive).toBe(false);
});
it("browses files, detects stale saves and runs an independent workspace shell", async () => {
  const fixture = run();
  await mkdir(fixture.node.worktree, { recursive: true });
  seed();
  await start();
  const file = "/api/v1/runs/r1/file?path=example.txt";
  const save = (text: string, version: string | null) => fetch(url(file), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, version }) });
  expect((await save("first", null)).status).toBe(200);
  const opened = await (await fetch(url(file))).json() as { text: string; version: string };
  expect(opened.text).toBe("first");
  expect((await save("second", opened.version)).status).toBe(200);
  expect((await save("stale", opened.version)).status).toBe(409);
  const files = await (await fetch(url("/api/v1/runs/r1/files"))).json() as { entries: { name: string }[] };
  expect(files.entries.some(entry => entry.name === "example.txt")).toBe(true);
  expect((await post("/api/v1/runs/r1/shell", {})).status).toBe(201);
  const command = `"${process.execPath}" -e "console.log('shell-'+'ready')"` + (process.platform === "win32" ? "\r" : "\n");
  expect((await post("/api/v1/sessions/r1-shell/input", { data: command })).status).toBe(204);
  let output = "";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await (await fetch(url("/api/v1/sessions/r1-shell/output"))).json() as { lines: string[] };
    output = result.lines.join("\n");
    if (output.includes("shell-ready")) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  expect(output).toContain("shell-ready");
  expect((await post("/api/v1/runs/r1/clean", {})).status).toBe(409);
  expect((await fetch(url("/api/v1/runs/r1/shell"), { method: "DELETE" })).status).toBe(204);
});
it("notifies completed work once across daemon restarts without exposing task text",async()=>{
  const store=openStore(data);const r=run();r.node.status="done";r.task="private task text";store.saveRun(r);store.close();
  const notices:{title:string;body:string}[]=[];
  const opts={data,runFile,port:0,notify:async(n:{title:string;body:string})=>{notices.push(n);}};
  daemon=await startDaemon(opts);
  const deadline=Date.now()+5000;
  while(!notices.length && Date.now()<deadline) await new Promise(r=>setTimeout(r,25));
  expect(notices).toEqual([{title:"Rivet",body:"r1: Task finished. Open Rivet to review."}]);
  await daemon.stop();daemon=await startDaemon(opts);
  await new Promise(r=>setTimeout(r,1300));
  expect(notices).toHaveLength(1);
});

it("notifies permission and question activity without including private request details",async()=>{
  seed();const notices:{title:string;body:string}[]=[];
  daemon=await startDaemon({data,runFile,port:0,notify:async n=>{notices.push(n);}});
  const wait=async(text:string)=>{const end=Date.now()+4000;while(!notices.some(n=>n.body.includes(text))&&Date.now()<end)await new Promise(r=>setTimeout(r,25));expect(notices.some(n=>n.body.includes(text))).toBe(true);};
  expect((await post("/api/v1/sessions/r1-agent/activity",{state:"approval",request:{tool:"Bash",detail:"private command"}})).status).toBe(204);
  await wait("Approval is requested");
  expect((await post("/api/v1/sessions/r1-agent/activity",{state:"asking"})).status).toBe(204);
  await wait("An answer is requested");
  expect(JSON.stringify(notices)).not.toContain("private command");
});
