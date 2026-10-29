import { describe, expect, it } from "vitest";
import { cleanupQueue } from "../src/daemon/cleanup.js";

describe("background cleanup", () => {
  it("returns a job immediately, deduplicates active requests, and drains on shutdown", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const queue = cleanupQueue(async () => { await hold; return { removed: ["agent"], kept: [] }; });
    const job = queue.submit("r1");
    expect(job.state).toBe("queued"); expect(queue.submit("r1").id).toBe(job.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(queue.get(job.id)?.state).toBe("running");
    let drained = false; const closing = queue.close().then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve)); expect(drained).toBe(false);
    release(); await closing;
    expect(queue.get(job.id)).toMatchObject({ state: "completed", result: { removed: ["agent"], kept: [] } });
    expect(() => queue.submit("r2")).toThrow("shutting down");
  });
  it("records failures and leaves unrelated jobs available", async () => {
    const queue = cleanupQueue(async (run) => { if (run === "bad") throw Object.assign(new Error("refused"), { status: 409 }); return { removed: [], kept: ["agent"] }; });
    const bad = queue.submit("bad"), good = queue.submit("good"); await queue.close();
    expect(queue.get(bad.id)).toMatchObject({ state: "failed", error: { status: 409, message: "refused" } });
    expect(queue.get(good.id)).toMatchObject({ state: "completed", result: { kept: ["agent"] } });
    expect(queue.get("missing")).toBeUndefined();
  });
});
