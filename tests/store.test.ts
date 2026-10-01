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
    expect(versions()).toEqual([1, 2]);
    store.close();
    store = openStore(data);
    expect(versions()).toEqual([1, 2]);
  });

  it("applies migration 2 once to a version 1 database", () => {
    store.saveRun(sampleRun());
    store.close();
    const db = new DatabaseSync(join(data, "rivet.db"));
    db.exec("DROP TABLE reports; DROP TABLE outbox; ALTER TABLE nodes DROP COLUMN agent_session_id; DELETE FROM schema_migrations WHERE version = 2");
    db.close();
    expect(versions()).toEqual([1]);
    store = openStore(data);
    expect(versions()).toEqual([1, 2]);
    expect(store.loadRun("r1").nodes).toHaveLength(2);
    store.close();
    store = openStore(data);
    expect(versions()).toEqual([1, 2]);
  });
});
