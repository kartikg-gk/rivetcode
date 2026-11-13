import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/agents/agent.js";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { makeDataDir, makeRepo, removeRepo } from "./helpers.js";

// Heavier use than the other tests: many sessions at once, many readers, long histories and
// large diffs. Each step has a time bound a person would notice if it were missed.
let daemon: Daemon | undefined;
let repo = "", data = "";
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  delete process.env.RIVET_CHAT_COMMAND;
  if (repo) await removeRepo(repo);
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${daemon!.port}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
async function until<T>(what: string, check: () => Promise<T | false | undefined | null>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("under load", () => {
  it("starts many chat sessions at once, answers many readers, and keeps long histories and big diffs usable", async () => {
    repo = await makeRepo();
    data = await makeDataDir();
    process.env.RIVET_CHAT_COMMAND = JSON.stringify([process.execPath, fileURLToPath(new URL("./fake-delta-agent.mjs", import.meta.url))]);
    daemon = await startDaemon({ data, runFile: join(data, "running.json"), port: 0, stopWaitMs: 500, onError: (e) => console.log("DAEMON ERROR", (e as Error)?.stack ?? e), agents: (name) => ({ ...getAgent("fake"), name, binary: "unused" }) });

    // 40 sessions started together, each with its own worktree and agent process.
    const SESSIONS = 40;
    let t = Date.now();
    const started = await Promise.all(Array.from({ length: SESSIONS }, (_, i) => api("POST", "/api/v1/runs", { repo, task: `WRITE w${i}`, agent: "delta" })));
    expect(started.every((r) => r.status < 300)).toBe(true);
    const ids = started.map((r) => r.json.runId as string);
    await until("every session's first reply", async () => {
      const runs = await Promise.all(ids.map((id) => api("GET", `/api/v1/runs/${id}`)));
      return runs.every((r) => r.json.run.node.activity === "idle");
    }, 180_000);
    const startAll = Date.now() - t;

    // 400 reads in waves of 50 at once (a busy app and many agents' hooks) across the list,
    // details and timelines.
    t = Date.now();
    const reads: { status: number; json: any }[] = [];
    for (let wave = 0; wave < 8; wave++) {
      reads.push(...await Promise.all(Array.from({ length: 50 }, (_, j) => {
        const i = wave * 50 + j, id = ids[i % ids.length]!;
        return api("GET", i % 3 === 0 ? "/api/v1/runs" : i % 3 === 1 ? `/api/v1/runs/${id}` : `/api/v1/runs/${id}/timeline?limit=50`);
      })));
    }
    const readAll = Date.now() - t;
    expect(reads.every((r) => r.status === 200)).toBe(true);
    expect((await api("GET", "/api/v1/runs")).json.runs.length).toBe(SESSIONS);

    // One session with a long conversation: 100 more turns, then its history is paged quickly.
    const busy = ids[0]!;
    const tq = Date.now();
    for (let i = 0; i < 100; i++) await api("POST", `/api/v1/sessions/${busy}-agent/send`, { message: `note ${i}`, mode: "queue" });
    await until("100 queued turns", async () => {
      const r = await api("GET", `/api/v1/runs/${busy}/timeline?limit=1`);
      return r.json.total >= 200 && (await api("GET", `/api/v1/runs/${busy}`)).json.run.node.activity === "idle";
    }, 240_000);
    const turnMs = (Date.now() - tq) / 100;
    t = Date.now();
    const page = await api("GET", `/api/v1/runs/${busy}/timeline?limit=200`);
    const turns = await api("GET", `/api/v1/runs/${busy}/turns`);
    const readLong = Date.now() - t;
    expect(page.json.items.length).toBe(100);
    expect(turns.status).toBe(200);

    // A big change in a worktree: the diff is cut, not sent whole, and still answers fast.
    const worktree = (await api("GET", `/api/v1/runs/${ids[1]}`)).json.run.node.worktree as string;
    writeFileSync(join(worktree, "big.txt"), "line of text that is not short\n".repeat(200_000));
    await (await import("../src/git.js")).git(["add", "big.txt"], worktree);
    t = Date.now();
    const diff = await api("GET", `/api/v1/runs/${ids[1]}/diff`);
    const bigDiff = Date.now() - t;
    expect(diff.status).toBe(200);
    expect(diff.json.cut).toBe(true);
    expect(diff.json.files.some((f: { path: string }) => f.path === "big.txt")).toBe(true);

    console.log(JSON.stringify({ turnMs, startAllMs: startAll, read400Ms: readAll, longHistoryMs: readLong, bigDiffMs: bigDiff }));
    expect(startAll).toBeLessThan(120_000);
    expect(readAll).toBeLessThan(15_000);
    expect(readLong).toBeLessThan(10_000);
    expect(bigDiff).toBeLessThan(15_000);
  }, 600_000);
});
