import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The event log is only complete if every change to a run's state is logged where it is
// made. This reads the store's source: a method that writes a run's tables but never
// calls logEvent fails here, naming the method.
const TRACKED = /\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(?:nodes|outbox|reports|pull_requests|reviews)\b/;

describe("event log write paths", () => {
  it("logs an event in every store method that changes a run's state", () => {
    const src = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    // Prepared statements that write the tracked tables, by name.
    const writers = [...src.matchAll(/const (\w+) = db\.prepare\(([`"])([\s\S]*?)\2\)/g)]
      .filter((m) => TRACKED.test(m[3]!))
      .map((m) => m[1]!);
    expect(writers.length).toBeGreaterThan(0);

    const body = src.slice(src.indexOf("const store: Store = {"));
    const methods = [...body.matchAll(/\n    (\w+)\([^)]*\) \{\n([\s\S]*?)\n    \},/g)];
    expect(methods.length).toBeGreaterThan(10);
    const unlogged = methods
      .filter(([, , code]) => TRACKED.test(code!) || writers.some((w) => new RegExp(`\\b${w}\\.run\\(`).test(code!)))
      .filter(([, , code]) => !code!.includes("logEvent("))
      .map(([, name]) => name);
    expect(unlogged).toEqual([]);
  });
});
