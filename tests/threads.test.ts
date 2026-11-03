import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type Daemon } from "../src/daemon/server.js";
import { openStore } from "../src/store.js";
import { makeDataDir, removeRepo, sessionRun } from "./helpers.js";

let data: string;
let daemon: Daemon | undefined;

beforeEach(async () => {
  data = await makeDataDir();
  const store = openStore(data);
  store.saveRun({ ...sessionRun(data, { id: "r1", project: "proj", task: "task" }), repo: join(data, "repo") });
  store.close();
  daemon = await startDaemon({ data, runFile: join(data, "running.json"), port: 0 });
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await removeRepo(data);
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${daemon!.port}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const org = async () => (await api("GET", "/api/v1/runs")).json.runs[0].organization;

describe("a thread's place in the list", () => {
  it("is pinned, snoozed, marked unread and busy, and each undone", async () => {
    expect(await org()).toMatchObject({ pinnedAt: null, snoozedUntil: null, unread: false, busy: null });
    const until = new Date(Date.now() + 3600_000).toISOString();
    expect((await api("PATCH", "/api/v1/runs/r1/organization", { pinned: true, snoozedUntil: until, unread: true, busy: "building" })).status).toBe(200);
    expect(await org()).toMatchObject({ snoozedUntil: until, unread: true, busy: "building" });
    expect((await org()).pinnedAt).toBeTruthy();
    await api("PATCH", "/api/v1/runs/r1/organization", { pinned: false, snoozedUntil: null, unread: false, busy: null });
    expect(await org()).toMatchObject({ pinnedAt: null, snoozedUntil: null, unread: false, busy: null });
  });

  it("refuses a time that is not one", async () => {
    expect((await api("PATCH", "/api/v1/runs/r1/organization", { snoozedUntil: "soon" })).status).toBe(400);
    expect((await api("PATCH", "/api/v1/runs/r1/organization", { busy: "" })).status).toBe(400);
  });
});

describe("a message still waiting for a session", () => {
  it("can be read, changed and withdrawn until it goes out", async () => {
    const store = openStore(data);
    const id = store.queueMessage("r1", "agent", "first text", undefined, "queue")!;
    store.close();
    expect((await api("GET", "/api/v1/sessions/r1-agent/queue")).json.messages).toEqual([{ id, message: "first text", mode: "queue" }]);
    expect((await api("PATCH", `/api/v1/sessions/r1-agent/queue/${id}`, { message: "second text" })).status).toBe(200);
    expect((await api("GET", "/api/v1/sessions/r1-agent/queue")).json.messages[0].message).toBe("second text");
    expect((await api("DELETE", `/api/v1/sessions/r1-agent/queue/${id}`)).status).toBe(204);
    expect((await api("GET", "/api/v1/sessions/r1-agent/queue")).json.messages).toEqual([]);
    expect((await api("PATCH", `/api/v1/sessions/r1-agent/queue/${id}`, { message: "late" })).status).toBe(409);
  });
});

describe("a secret an agent asks for", () => {
  it("reaches it only as a file, and is listed until answered", async () => {
    const asked = api("POST", "/api/v1/sessions/r1-agent/secret", { name: "TOKEN", why: "deploy" });
    let request: { id: string; name: string } | undefined;
    for (let i = 0; i < 100 && !request; i++) {
      request = (await api("GET", "/api/v1/runs/r1")).json.secretRequest;
      if (!request) await new Promise((r) => setTimeout(r, 20));
    }
    expect(request).toMatchObject({ name: "TOKEN" });
    expect((await api("GET", "/api/v1/runs")).json.runs[0].needsAnswer).toBe(true);
    expect((await api("POST", "/api/v1/runs/r1/secret", { id: "wrong", value: "x" })).status).toBe(409);
    expect((await api("POST", "/api/v1/runs/r1/secret", { id: request!.id, value: "s3cret-value" })).status).toBe(204);
    const { json } = await asked;
    expect(await readFile(json.path, "utf8")).toBe("s3cret-value");
    expect(JSON.stringify((await api("GET", "/api/v1/runs/r1/timeline?view=activity&limit=50")).json)).not.toContain("s3cret-value");
    await daemon!.stop();
    daemon = await startDaemon({ data, runFile: join(data, "running.json"), port: 0 });
    // A restarted daemon clears whatever was given before.
    expect(existsSync(json.path)).toBe(false);
  });

  it("comes back refused when the person says no", async () => {
    const asked = api("POST", "/api/v1/sessions/r1-agent/secret", { name: "TOKEN", why: "deploy" });
    let id: string | undefined;
    for (let i = 0; i < 100 && !id; i++) {
      id = (await api("GET", "/api/v1/runs/r1")).json.secretRequest?.id;
      if (!id) await new Promise((r) => setTimeout(r, 20));
    }
    await api("POST", "/api/v1/runs/r1/secret", { id, refuse: true });
    expect((await asked).json).toEqual({ refused: true });
  });
});

describe("linking a pull request", () => {
  it("refuses a number that is not one, and unlinks", async () => {
    expect((await api("POST", "/api/v1/runs/r1/link-pr", { number: "seven" })).status).toBe(400);
    const store = openStore(data);
    store.setPr("r1", { number: 7, url: "https://github.com/o/r/pull/7" });
    store.close();
    expect((await api("POST", "/api/v1/runs/r1/link-pr", { number: null })).json).toEqual({ pr: null });
    expect((await api("GET", "/api/v1/runs/r1")).json.pr).toBeNull();
  });
});
