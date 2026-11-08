import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertId } from "../src/paths.js";
import { newRunId, openStore, RunStoreError, type Run, type Store } from "../src/store.js";
import { setStatus } from "../src/model.js";
import { makeDataDir, removeRepo, sessionRun } from "./helpers.js";

let data: string;
let store: Store;
beforeEach(async () => {
  data = await makeDataDir();
  store = openStore(data);
});
afterEach(async () => {
  store.close();
  await removeRepo(data);
});

const sampleRun = (id = "r1", project = "proj"): Run => sessionRun(data, { id, project });

describe("newRunId", () => {
  it("is a valid, unique run id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRunId(1_790_000_000_000)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(() => assertId("run", id)).not.toThrow();
  });
});

describe("openStore", () => {
  it("keeps the database at <data>/rivet.db", () => {
    expect(existsSync(join(data, "rivet.db"))).toBe(true);
  });

  it("keeps runs across reopening", () => {
    store.saveRun(sampleRun());
    store.close();
    store = openStore(data);
    expect(store.loadRun("r1").task).toBe("add login");
  });
});

describe("project records", () => {
  it("refuses active project deletion and removes only that project's stored threads and preferences", () => {
    const run = sampleRun();
    store.saveRun(run);
    store.saveRun(sampleRun("r2", "unrelated"));
    store.saveProject({ id: run.project, repo: run.repo, title: "Example", instructions: "Keep changes small", scripts: [{ id: "check", command: "npm test" }] });
    store.setEnvironmentInstructions("Shared instructions");
    expect(store.projectMetadata(run.project)?.scripts).toEqual([{ id: "check", command: "npm test" }]);
    expect(() => store.deleteProject(run.project)).toThrow(/active and pending/);
    store.updateNode(run.id, run.node.id, { status: "done" });
    store.addLinkedPr(run.id, { number: 2, url: "https://github.com/a/b/pull/2", status: "open" });
    store.addLinkedPr(run.id, { number: 3, url: "https://github.com/a/b/pull/3", status: "open" });
    store.writePrGuides(run.id, [{ number: 2, text: "First guide" }, { number: 3, text: "Second guide" }]);
    expect(store.linkedPrs(run.id).map(pr => pr.number)).toEqual([2, 3]);
    expect(store.readPrGuide(run.id, 3)).toBe("Second guide");
    store.deleteProject(run.project);
    expect(store.projectMetadata(run.project)).toBeNull();
    expect(store.listRuns()).toEqual(["r2"]);
    expect(store.linkedPrs(run.id)).toEqual([]);
    expect(store.readPrGuide(run.id, 3)).toBeNull();
    expect(store.environmentInstructions()).toBe("Shared instructions");
    expect(() => store.saveRun(run)).toThrow(/project has been deleted/);
    expect(store.verifyJournal().valid).toBe(true);
  });
});

describe("saveRun / loadRun", () => {
  it("round-trips a run and every field", () => {
    const run: Run = {
      ...sampleRun(), role: "orchestrator", name: "login work", orchestrator: "r0-agent", model: "haiku",
      node: { ...sampleRun().node, prStatus: "open", activity: "waiting_input", summary: "s" },
    };
    store.saveRun(run);
    expect(store.loadRun("r1")).toEqual(run);
  });

  it("overwrites with the latest state", () => {
    const run = sampleRun();
    store.saveRun(run);
    store.saveRun({ ...run, node: setStatus(run.node, "running") });
    expect(store.loadRun("r1").node).toMatchObject({ status: "running", attempts: 1 });
  });

  it("reports a missing run clearly", () => {
    expect(() => store.loadRun("nope")).toThrow(RunStoreError);
    expect(() => store.loadRun("nope")).toThrow(/no run nope/);
  });

  it.each([
    ["an unknown role", (r: any) => { r.role = "boss"; }],
    ["an unknown status", (r: any) => { r.node.status = "zzz"; }],
    ["an unknown agent", (r: any) => { r.node.agent = "gpt"; }],
    ["an unknown activity", (r: any) => { r.node.activity = "sleeping"; }],
    ["an unknown PR status", (r: any) => { r.node.prStatus = "shipped"; }],
    ["negative attempts", (r: any) => { r.node.attempts = -1; }],
    ["a bad node id", (r: any) => { r.node.id = "../x"; }],
    ["a branch that is not the node's own", (r: any) => { r.node.branch = "main"; }],
  ])("refuses to save %s, and keeps the previous state", (_name, mutate) => {
    store.saveRun(sampleRun());
    const bad = structuredClone(sampleRun());
    bad.task = "changed";
    mutate(bad);
    expect(() => store.saveRun(bad)).toThrow(RunStoreError);
    expect(store.loadRun("r1").task).toBe("add login");
  });
});

describe("listRuns", () => {
  it("is empty when nothing was saved", () => {
    expect(store.listRuns()).toEqual([]);
  });

  it("lists runs sorted, optionally for one project", () => {
    store.saveRun(sampleRun("r2", "a"));
    store.saveRun(sampleRun("r1", "b"));
    expect(store.listRuns()).toEqual(["r1", "r2"]);
    expect(store.listRuns("a")).toEqual(["r2"]);
  });
});

describe("busy database", () => {
  it("waits for another writer instead of failing", async () => {
    store.saveRun(sampleRun());
    const holder = spawn(process.execPath, [
      "--no-warnings",
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN IMMEDIATE");
       console.log("locked");
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
       db.exec("COMMIT");`,
      join(data, "rivet.db"),
    ]);
    await new Promise<void>((ok) => holder.stdout.once("data", () => ok()));

    expect(() => store.saveRun({ ...sampleRun(), task: "after wait" })).not.toThrow();
    expect(store.loadRun("r1").task).toBe("after wait");
    await new Promise((ok) => holder.once("exit", ok));
  });
});

describe("schema migrations", () => {
  const versions = () => {
    const db = new DatabaseSync(join(data, "rivet.db"));
    try {
      return (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[])
        .map((r) => r.version);
    } finally {
      db.close();
    }
  };

  it("records each applied migration once, across reopening", () => {
    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
    store.close();
    store = openStore(data);
    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
  });

  it("applies migrations 2 and 3 once to a version 1 database", () => {
    store.saveRun(sampleRun());
    store.close();
    const db = new DatabaseSync(join(data, "rivet.db"));
    db.exec("DROP TABLE lifecycle_state; DROP TABLE environment_preferences; DROP TABLE linked_pull_requests; DROP TABLE registered_projects; DROP TABLE pull_request_guides; DROP TABLE run_organization; DROP TABLE recovery_journal; DROP TABLE conversation_branches; DROP TABLE wait_subscriptions; DROP TABLE chat_receipts; DROP TRIGGER chat_search_insert; DROP TRIGGER chat_search_update; DROP TRIGGER chat_search_delete; DROP TRIGGER timeline_search_insert; DROP TRIGGER timeline_search_delete; DROP TABLE chat_search; DROP TABLE timeline_search; DROP TABLE context_transfers; DROP TABLE thread_forks; ALTER TABLE chat_turns DROP COLUMN agent; DROP TABLE chat_provider_events; DROP TABLE chat_log; DROP TABLE chat_turns; DROP TABLE chat_conversations; ALTER TABLE nodes DROP COLUMN provider_conversation_id; ALTER TABLE nodes DROP COLUMN session_mode; DROP TABLE events; DROP TABLE timeline; ALTER TABLE outbox DROP COLUMN mode; ALTER TABLE runs DROP COLUMN spec; DROP TABLE automation_runs; DROP TABLE automations; DROP TABLE cues; DROP TABLE reviews; ALTER TABLE runs DROP COLUMN issue; ALTER TABLE runs DROP COLUMN role; ALTER TABLE runs DROP COLUMN name; ALTER TABLE runs DROP COLUMN orchestrator; ALTER TABLE runs DROP COLUMN model; ALTER TABLE nodes DROP COLUMN shared; DROP TABLE conversations; ALTER TABLE nodes DROP COLUMN started_at; ALTER TABLE nodes DROP COLUMN first_signal_at; DROP TABLE pull_requests; ALTER TABLE runs DROP COLUMN terminate_on_pr_merge; DROP TABLE reports; DROP TABLE outbox; DROP TABLE project_config; ALTER TABLE nodes DROP COLUMN agent_session_id; ALTER TABLE nodes DROP COLUMN activity_at; ALTER TABLE nodes DROP COLUMN finished_at; DELETE FROM schema_migrations WHERE version >= 2");
    db.close();
    expect(versions()).toEqual([1]);
    store = openStore(data);
    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
    expect(store.loadRun("r1")).toMatchObject({ role: "worker", name: "", node: { id: "agent" } });
    store.close();
    store = openStore(data);
    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
  });
});

describe("outbox and stale sessions", () => {
  it("lists undelivered messages oldest first and marks them delivered", () => {
    store.saveRun(sampleRun());
    store.saveRun(sampleRun("r2"));
    const first = store.queueMessage("r1", "agent", "one")!;
    const second = store.queueMessage("r1", "agent", "two", "r2-agent", "queue")!;
    store.queueMessage("r2", "agent", "for the other");
    expect(store.undeliveredMessages("r1", "agent")).toEqual([
      { id: first, message: "one", mode: "steer" }, { id: second, message: "two", mode: "queue" },
    ]);
    store.markDelivered(first);
    expect(store.undeliveredMessages("r1", "agent")).toEqual([{ id: second, message: "two", mode: "queue" }]);
  });

  it("marks every session that still looks alive as exited", () => {
    store.saveRun(sampleRun());
    store.saveRun(sampleRun("r2"));
    store.setActivity("r1", "agent", "active");
    store.setActivity("r2", "agent", "idle");
    expect(store.exitStaleSessions()).toBe(2);
    expect([store.loadRun("r1").node.activity, store.loadRun("r2").node.activity]).toEqual(["exited", "exited"]);
    expect(store.exitStaleSessions()).toBe(0);
  });
});

describe("migration 3 and project config", () => {
  it("keeps a session and its fields through the table rebuild", () => {
    const run = sampleRun();
    run.node = { ...run.node, status: "running", attempts: 1, summary: "s", agentSessionId: "c1" };
    store.saveRun(run);
    store.close();
    const db = new DatabaseSync(join(data, "rivet.db"));
    db.exec("DROP TABLE lifecycle_state; DROP TABLE environment_preferences; DROP TABLE linked_pull_requests; DROP TABLE registered_projects; DROP TABLE pull_request_guides; DROP TABLE run_organization; DROP TABLE recovery_journal; DROP TABLE conversation_branches; DROP TABLE wait_subscriptions; DROP TABLE chat_receipts; DROP TRIGGER chat_search_insert; DROP TRIGGER chat_search_update; DROP TRIGGER chat_search_delete; DROP TRIGGER timeline_search_insert; DROP TRIGGER timeline_search_delete; DROP TABLE chat_search; DROP TABLE timeline_search; DROP TABLE context_transfers; DROP TABLE thread_forks; DELETE FROM schema_migrations WHERE version >= 3; ALTER TABLE chat_turns DROP COLUMN agent; DROP TABLE chat_provider_events; DROP TABLE chat_log; DROP TABLE chat_turns; DROP TABLE chat_conversations; ALTER TABLE nodes DROP COLUMN provider_conversation_id; ALTER TABLE nodes DROP COLUMN session_mode; DROP TABLE events; DROP TABLE timeline; ALTER TABLE outbox DROP COLUMN mode; ALTER TABLE runs DROP COLUMN spec; DROP TABLE automation_runs; DROP TABLE automations; DROP TABLE cues; DROP TABLE reviews; ALTER TABLE runs DROP COLUMN issue; ALTER TABLE runs DROP COLUMN role; ALTER TABLE runs DROP COLUMN name; ALTER TABLE runs DROP COLUMN orchestrator; ALTER TABLE runs DROP COLUMN model; ALTER TABLE nodes DROP COLUMN shared; DROP TABLE conversations; ALTER TABLE nodes DROP COLUMN started_at; ALTER TABLE nodes DROP COLUMN first_signal_at; DROP TABLE project_config; DROP TABLE pull_requests; ALTER TABLE runs DROP COLUMN terminate_on_pr_merge;");
    db.exec("CREATE TABLE n2 AS SELECT run_id, id, position, parent_id, depth, kind, title, prompt, files, agent, branch, worktree, status, attempts, summary, activity, pr_status, agent_session_id FROM nodes; DROP TABLE nodes; ALTER TABLE n2 RENAME TO nodes;");
    db.close();
    store = openStore(data);
    expect(store.loadRun("r1")).toEqual(run);
  });

  it("stores fake agents, activity and finish times", () => {
    const run = sampleRun();
    run.node = { ...run.node, agent: "fake", finishedAt: "2026-10-04T10:00:00.000Z" };
    store.saveRun(run);
    store.setActivity("r1", "agent", "idle");
    const loaded = store.loadRun("r1");
    expect(loaded.node).toMatchObject({ agent: "fake", finishedAt: "2026-10-04T10:00:00.000Z", activity: "idle" });
    expect(Date.parse(loaded.node.activityAt!)).toBeGreaterThan(Date.now() - 5000);
  });

  it("sets, reads and clears project settings", () => {
    store.setConfig("proj", "check", "npm run typecheck");
    store.setConfig("proj", "test", "npm test");
    store.setConfig("other", "check", "make");
    expect(store.getConfig("proj")).toEqual({ check: "npm run typecheck", test: "npm test" });
    store.setConfig("proj", "test", null);
    expect(store.getConfig("proj")).toEqual({ check: "npm run typecheck" });
  });
});

describe("updateNode", () => {
  it("changes only the given fields and leaves activity alone", () => {
    store.saveRun(sampleRun());
    store.setActivity("r1", "agent", "blocked", "conv");
    store.updateNode("r1", "agent", { status: "running", attempts: 1, finishedAt: "2026-10-04T00:00:00.000Z" });
    store.updateNode("r1", "agent", { summary: "half way" });
    expect(store.loadRun("r1").node).toMatchObject({
      status: "running", attempts: 1, summary: "half way", activity: "blocked", agentSessionId: "conv",
      finishedAt: "2026-10-04T00:00:00.000Z",
    });
    store.updateNode("r1", "agent", { finishedAt: null, summary: null });
    const n = store.loadRun("r1").node;
    expect(n.finishedAt).toBeUndefined();
    expect(n.summary).toBeUndefined();
  });

  it("rejects unknown nodes and invalid statuses", () => {
    store.saveRun(sampleRun());
    expect(() => store.updateNode("r1", "other", { status: "done" })).toThrow(/no node other/);
    expect(() => store.updateNode("r1", "agent", { status: "bogus" as never })).toThrow();
  });
});

describe("pull requests", () => {
  it("remembers a run's pull request and what was already handled", () => {
    store.saveRun(sampleRun());
    expect(store.getPr("r1")).toBeNull();
    store.setPr("r1", { number: 7, url: "https://github.com/o/r/pull/7" });
    expect(store.getPr("r1")).toEqual({ number: 7, url: "https://github.com/o/r/pull/7" });
    store.setPr("r1", { number: 7, url: "https://github.com/o/r/pull/7", handled: "ci:abc" });
    expect(store.getPr("r1")!.handled).toBe("ci:abc");
  });
});

describe("timeline", () => {
  it("keeps entries in order, pages them, narrows to messages, and skips a prompt seen twice", () => {
    store.saveRun(sampleRun());
    store.addTimeline("r1", "agent", [{ kind: "prompt", text: "do it" }]);
    // A hook seeing the same prompt again adds nothing.
    store.addTimeline("r1", "agent", [{ kind: "prompt", text: "do it" }, { kind: "tool", tool: "Bash", text: "npm test" }]);
    store.addTimeline("r1", "agent", [{ kind: "assistant", text: "done" }]);
    store.addTimeline("r1", "review", [{ kind: "prompt", text: "review it" }]);
    const all = store.readTimeline("r1", { limit: 10 });
    expect(all.total).toBe(4);
    expect(all.items.map((i) => [i.session, i.kind, i.text])).toEqual([
      ["agent", "prompt", "do it"], ["agent", "tool", "npm test"], ["agent", "assistant", "done"], ["review", "prompt", "review it"],
    ]);
    const messages = store.readTimeline("r1", { limit: 10, kinds: ["prompt", "message", "assistant"], session: "agent" });
    expect(messages.items.map((i) => i.text)).toEqual(["do it", "done"]);
    const page = store.readTimeline("r1", { limit: 2 });
    expect(store.readTimeline("r1", { limit: 10, after: page.items[1]!.position }).items.map((i) => i.text)).toEqual(["done", "review it"]);
  });

  it("logs each change to a run's state, but not a repeated activity", () => {
    store.saveRun(sampleRun());
    store.setActivity("r1", "agent", "active");
    store.setActivity("r1", "agent", "active");
    store.setActivity("r1", "agent", "idle");
    const id = store.queueMessage("r1", "agent", "hi", "orchestrator", "queue")!;
    store.markDelivered(id);
    store.markDelivered(id);
    store.createReport("r1", "agent", "done", "ok");
    store.updateNode("r1", "agent", { status: "done" });
    store.updateNode("r1", "agent", { status: "done" });
    store.setPr("r1", { number: 7, url: "u" });
    expect(store.readEvents("r1", { limit: 50 }).map((e) => [e.type, e.data])).toEqual([
      ["run.added", { status: sampleRun().node.status, agent: sampleRun().node.agent }],
      ["activity", { from: null, to: "active" }],
      ["activity", { from: "active", to: "idle" }],
      ["message.queued", { id, mode: "queue", from: "orchestrator" }],
      ["message.delivered", { id }],
      ["report", { kind: "done" }],
      ["run.changed", { status: "done" }],
      ["pr", { number: 7, handled: null }],
    ]);
    const first = store.readEvents("r1", { limit: 2 });
    expect(store.readEvents("r1", { limit: 1, after: first[1]!.position })[0]!.data).toEqual({ from: "active", to: "idle" });
  });

  it("logs a run's creation once, a re-save only when its status changed, and sessions closed at startup", () => {
    const run = sampleRun();
    store.saveRun(run);
    store.saveRun(run);
    store.saveRun({ ...run, node: { ...run.node, status: "done" } });
    store.setActivity("r1", "agent", "active");
    store.exitStaleSessions();
    expect(store.readEvents("r1", { limit: 50 }).map((e) => [e.type, e.data])).toEqual([
      ["run.added", { status: run.node.status, agent: run.node.agent }],
      ["run.changed", { status: "done" }],
      ["activity", { from: null, to: "active" }],
      ["session.ended", { from: "active", reason: "daemon restarted" }],
    ]);
  });

  it("stores entries without secrets", () => {
    store.saveRun(sampleRun());
    store.addTimeline("r1", "agent", [{ kind: "result", tool: "Bash", text: "GITHUB_TOKEN=abcdef123456" }]);
    expect(store.readTimeline("r1", { limit: 10 }).items[0]!.text).toBe("GITHUB_TOKEN=[secret removed]");
  });

  it("prunes only the timelines of runs that finished before the cutoff", () => {
    store.saveRun(sampleRun());
    store.addTimeline("r1", "agent", [{ kind: "assistant", text: "working" }]);
    // Still running: kept however old.
    expect(store.pruneTimeline(sampleRun().project, "2999-01-01T00:00:00.000Z")).toBe(0);
    store.updateNode("r1", "agent", { finishedAt: "2026-10-01T00:00:00.000Z" });
    expect(store.pruneTimeline(sampleRun().project, "2026-09-01T00:00:00.000Z")).toBe(0);
    expect(store.pruneTimeline("other", "2026-11-01T00:00:00.000Z")).toBe(0);
    expect(store.pruneTimeline(sampleRun().project, "2026-11-01T00:00:00.000Z")).toBe(1);
    expect(store.readTimeline("r1", { limit: 10 }).total).toBe(0);
    expect(store.listProjects()).toEqual([sampleRun().project]);
  });
});


it("keeps a signaled terminal active until its first idle hook instead of reusing startup idle",()=>{
 const s=openStore(data);try{s.saveRun(sessionRun(data));s.markLaunched("r1","agent",true);expect(s.loadRun("r1").node.activity).toBe("active");s.recordSignal("r1","agent","idle");expect(s.loadRun("r1").node.activity).toBe("idle");}finally{s.close();}
});
