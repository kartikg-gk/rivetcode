import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertId } from "../src/paths.js";
import { newRunId, openStore, RunStoreError, type Run, type Store } from "../src/store.js";
import { buildTree, setStatus } from "../src/tree.js";
import { makeDataDir, removeRepo } from "./helpers.js";

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

function sampleRun(id = "r1", project = "proj"): Run {
  const nodes = buildTree({
    runId: id, project, dataDir: data, defaultAgent: "claude",
    plan: { title: "r", prompt: "p", children: [{ title: "a", prompt: "do a", files: ["src/a.ts"] }] },
  });
  return {
    id, project, repo: join(data, "..", "repo"), base: "main", task: "add login",
    createdAt: "2026-09-30T10:00:00.000Z", nodes,
  };
}

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
  it("round-trips a run, node order and every field", () => {
    const run = sampleRun();
    run.nodes = run.nodes.map((n) =>
      n.id === "root" ? { ...n, prStatus: "pr_open" as const } : { ...n, activity: "waiting_input" as const, summary: "s" },
    );
    store.saveRun(run);
    expect(store.loadRun("r1")).toEqual(run);
  });

  it("overwrites with the latest state", () => {
    const run = sampleRun();
    store.saveRun(run);
    store.saveRun({ ...run, nodes: setStatus(run.nodes, "root.1", "running") });
    expect(store.loadRun("r1").nodes[1]!.status).toBe("running");
    expect(store.loadRun("r1").nodes).toHaveLength(2);
  });

  it("reports a missing run clearly", () => {
    expect(() => store.loadRun("nope")).toThrow(RunStoreError);
    expect(() => store.loadRun("nope")).toThrow(/no run nope/);
  });

  it.each([
    ["an unknown kind", (r: any) => { r.nodes[0].kind = "bogus"; }],
    ["an unknown status", (r: any) => { r.nodes[1].status = "zzz"; }],
    ["an unknown agent", (r: any) => { r.nodes[1].agent = "gpt"; }],
    ["an unknown activity", (r: any) => { r.nodes[1].activity = "sleeping"; }],
    ["an unknown PR status", (r: any) => { r.nodes[0].prStatus = "shipped"; }],
    ["negative attempts", (r: any) => { r.nodes[1].attempts = -1; }],
    ["a bad node id", (r: any) => { r.nodes[1].id = "../x"; }],
    ["a branch that is not the node's own", (r: any) => { r.nodes[1].branch = "main"; }],
    ["a parent that does not exist", (r: any) => { r.nodes[1].parentId = "root.7"; }],
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
    expect(versions()).toEqual([1, 2, 3, 4, 5]);
    store.close();
    store = openStore(data);
    expect(versions()).toEqual([1, 2, 3, 4, 5]);
  });

  it("applies migrations 2 and 3 once to a version 1 database", () => {
    store.saveRun(sampleRun());
    store.close();
    const db = new DatabaseSync(join(data, "rivet.db"));
    db.exec("DROP TABLE pull_requests; ALTER TABLE runs DROP COLUMN terminate_on_pr_merge; DROP TABLE reports; DROP TABLE outbox; DROP TABLE project_config; ALTER TABLE nodes DROP COLUMN agent_session_id; ALTER TABLE nodes DROP COLUMN activity_at; ALTER TABLE nodes DROP COLUMN finished_at; DELETE FROM schema_migrations WHERE version >= 2");
    db.close();
    expect(versions()).toEqual([1]);
    store = openStore(data);
    expect(versions()).toEqual([1, 2, 3, 4, 5]);
    expect(store.loadRun("r1").nodes).toHaveLength(2);
    store.close();
    store = openStore(data);
    expect(versions()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("outbox and stale sessions", () => {
  it("lists undelivered messages oldest first and marks them delivered", () => {
    store.saveRun(sampleRun());
    const first = store.queueMessage("r1", "root.1", "one")!;
    const second = store.queueMessage("r1", "root.1", "two", "r1-root")!;
    store.queueMessage("r1", "root", "for the parent");
    expect(store.undeliveredMessages("r1", "root.1")).toEqual([
      { id: first, message: "one" }, { id: second, message: "two" },
    ]);
    store.markDelivered(first);
    expect(store.undeliveredMessages("r1", "root.1")).toEqual([{ id: second, message: "two" }]);
  });

  it("marks every session that still looks alive as exited", () => {
    store.saveRun(sampleRun());
    store.setActivity("r1", "root.1", "active");
    store.setActivity("r1", "root", "idle");
    expect(store.exitStaleSessions()).toBe(2);
    expect(store.loadRun("r1").nodes.map((n) => n.activity)).toEqual(["exited", "exited"]);
    expect(store.exitStaleSessions()).toBe(0);
  });
});

describe("migration 3 and project config", () => {
  it("keeps every node and its fields through the table rebuild", () => {
    const run = sampleRun();
    run.nodes[1] = { ...run.nodes[1]!, status: "running", attempts: 1, summary: "s", agentSessionId: "c1" };
    store.saveRun(run);
    store.close();
    const db = new DatabaseSync(join(data, "rivet.db"));
    db.exec("DELETE FROM schema_migrations WHERE version >= 3; DROP TABLE project_config; DROP TABLE pull_requests; ALTER TABLE runs DROP COLUMN terminate_on_pr_merge;");
    db.exec("CREATE TABLE n2 AS SELECT run_id, id, position, parent_id, depth, kind, title, prompt, files, agent, branch, worktree, status, attempts, summary, activity, pr_status, agent_session_id FROM nodes; DROP TABLE nodes; ALTER TABLE n2 RENAME TO nodes;");
    db.close();
    store = openStore(data);
    expect(store.loadRun("r1")).toEqual(run);
  });

  it("stores waiting parents, fake agents, activity and finish times", () => {
    const run = sampleRun();
    run.nodes[0] = { ...run.nodes[0]!, status: "waiting" };
    run.nodes[1] = { ...run.nodes[1]!, agent: "fake", finishedAt: "2026-10-04T10:00:00.000Z" };
    store.saveRun(run);
    store.setActivity("r1", "root.1", "idle");
    const loaded = store.loadRun("r1");
    expect(loaded.nodes[0]!.status).toBe("waiting");
    expect(loaded.nodes[1]).toMatchObject({ agent: "fake", finishedAt: "2026-10-04T10:00:00.000Z", activity: "idle" });
    expect(Date.parse(loaded.nodes[1]!.activityAt!)).toBeGreaterThan(Date.now() - 5000);
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
    store.setActivity("r1", "root.1", "blocked", "conv");
    store.updateNode("r1", "root.1", { status: "running", attempts: 1, finishedAt: "2026-10-04T00:00:00.000Z" });
    store.updateNode("r1", "root.1", { summary: "half way" });
    expect(store.loadRun("r1").nodes[1]).toMatchObject({
      status: "running", attempts: 1, summary: "half way", activity: "blocked", agentSessionId: "conv",
      finishedAt: "2026-10-04T00:00:00.000Z",
    });
    store.updateNode("r1", "root.1", { finishedAt: null, summary: null });
    const n = store.loadRun("r1").nodes[1]!;
    expect(n.finishedAt).toBeUndefined();
    expect(n.summary).toBeUndefined();
  });

  it("rejects unknown nodes and invalid statuses", () => {
    store.saveRun(sampleRun());
    expect(() => store.updateNode("r1", "root.9", { status: "done" })).toThrow(/no node root\.9/);
    expect(() => store.updateNode("r1", "root.1", { status: "bogus" as never })).toThrow();
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
