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

describe("saveRun / loadRun", () => {
  it("round-trips a run and every field", () => {
    const run: Run = {
      ...sampleRun(), role: "orchestrator", name: "login work", orchestrator: "r0-agent", model: "haiku",
      node: { ...sampleRun().node, prStatus: "pr_open", activity: "waiting_input", summary: "s" },
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
    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    store.close();
    store = openStore(data);
    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("applies migrations 2 and 3 once to a version 1 database", () => {
    store.saveRun(sampleRun());
    store.close();
    const db = new DatabaseSync(join(data, "rivet.db"));
    db.exec("ALTER TABLE runs DROP COLUMN role; ALTER TABLE runs DROP COLUMN name; ALTER TABLE runs DROP COLUMN orchestrator; ALTER TABLE runs DROP COLUMN model; ALTER TABLE nodes DROP COLUMN shared; DROP TABLE conversations; ALTER TABLE nodes DROP COLUMN started_at; ALTER TABLE nodes DROP COLUMN first_signal_at; DROP TABLE pull_requests; ALTER TABLE runs DROP COLUMN terminate_on_pr_merge; DROP TABLE reports; DROP TABLE outbox; DROP TABLE project_config; ALTER TABLE nodes DROP COLUMN agent_session_id; ALTER TABLE nodes DROP COLUMN activity_at; ALTER TABLE nodes DROP COLUMN finished_at; DELETE FROM schema_migrations WHERE version >= 2");
    db.close();
    expect(versions()).toEqual([1]);
    store = openStore(data);
    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(store.loadRun("r1")).toMatchObject({ role: "worker", name: "", node: { id: "agent" } });
    store.close();
    store = openStore(data);
    expect(versions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("outbox and stale sessions", () => {
  it("lists undelivered messages oldest first and marks them delivered", () => {
    store.saveRun(sampleRun());
    store.saveRun(sampleRun("r2"));
    const first = store.queueMessage("r1", "agent", "one")!;
    const second = store.queueMessage("r1", "agent", "two", "r2-agent")!;
    store.queueMessage("r2", "agent", "for the other");
    expect(store.undeliveredMessages("r1", "agent")).toEqual([
      { id: first, message: "one" }, { id: second, message: "two" },
    ]);
    store.markDelivered(first);
    expect(store.undeliveredMessages("r1", "agent")).toEqual([{ id: second, message: "two" }]);
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
    db.exec("DELETE FROM schema_migrations WHERE version >= 3; ALTER TABLE runs DROP COLUMN role; ALTER TABLE runs DROP COLUMN name; ALTER TABLE runs DROP COLUMN orchestrator; ALTER TABLE runs DROP COLUMN model; ALTER TABLE nodes DROP COLUMN shared; DROP TABLE conversations; ALTER TABLE nodes DROP COLUMN started_at; ALTER TABLE nodes DROP COLUMN first_signal_at; DROP TABLE project_config; DROP TABLE pull_requests; ALTER TABLE runs DROP COLUMN terminate_on_pr_merge;");
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
