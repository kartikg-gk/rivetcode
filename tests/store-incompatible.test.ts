import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openStore, schemaProblems } from "../src/store.js";
import { makeDataDir } from "./helpers.js";

describe("a database from an incompatible Rivet build", () => {
  it("is moved aside, kept, and a new one started, so Rivet still starts", async () => {
    const data = await makeDataDir();
    // Same migration numbers, other tables: what another build of Rivet would have left.
    const old = new DatabaseSync(join(data, "rivet.db"));
    old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let v = 1; v <= 200; v++) old.prepare("INSERT INTO schema_migrations VALUES (?, 'then')").run(v);
    old.exec("CREATE TABLE nodes (run_id TEXT, id TEXT, agent_session_id TEXT)");
    old.close();

    const store = openStore(data);
    expect(store.listRuns()).toEqual([]);
    store.close();
    const aside = readdirSync(data).filter((f) => f.startsWith("rivet.db.incompatible-") && !f.endsWith("-wal") && !f.endsWith("-shm"));
    expect(aside).toHaveLength(1);
    const kept = new DatabaseSync(join(data, aside[0]!));
    expect(kept.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 200 });
    kept.close();
  });

  it("leaves a database this build made alone", async () => {
    const data = await makeDataDir();
    openStore(data).close();
    openStore(data).close();
    expect(readdirSync(data).some((f) => f.includes("incompatible"))).toBe(false);
    const db = new DatabaseSync(join(data, "rivet.db"));
    expect(schemaProblems(db)).toEqual([]);
    db.close();
    expect(existsSync(join(data, "rivet.db"))).toBe(true);
  });
});
