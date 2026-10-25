import { describe, expect, it } from "vitest";
import { checkZone, nextRun, parseCron } from "../src/scheduler/cron.js";

const at = (iso: string) => new Date(iso);

describe("cron schedules", () => {
  it("finds the next minute named, in the schedule's time zone", () => {
    // 09:00 on weekdays in Kolkata (UTC+5:30) is 03:30 UTC.
    const weekdays9 = parseCron("0 9 * * 1-5");
    expect(nextRun(weekdays9, "Asia/Kolkata", at("2026-10-19T03:00:00Z")).toISOString()).toBe("2026-10-19T03:30:00.000Z");
    // Friday after nine: the next is Monday.
    expect(nextRun(weekdays9, "Asia/Kolkata", at("2026-10-23T04:00:00Z")).toISOString()).toBe("2026-10-26T03:30:00.000Z");
    expect(nextRun(parseCron("*/15 * * * *"), "UTC", at("2026-10-19T10:07:30Z")).toISOString()).toBe("2026-10-19T10:15:00.000Z");
    // Strictly after: a schedule due right now comes round next time.
    expect(nextRun(parseCron("0 * * * *"), "UTC", at("2026-10-19T10:00:00Z")).toISOString()).toBe("2026-10-19T11:00:00.000Z");
  });

  it("matches either day field when both are restricted, and takes 7 as Sunday", () => {
    // The 1st of the month or a Sunday, at midnight UTC. 2026-11-01 is a Sunday; 2026-10-25 is one too.
    expect(nextRun(parseCron("0 0 1 * 7"), "UTC", at("2026-10-20T00:00:00Z")).toISOString()).toBe("2026-10-25T00:00:00.000Z");
    expect(nextRun(parseCron("30 2 1 * *"), "UTC", at("2026-10-20T00:00:00Z")).toISOString()).toBe("2026-11-01T02:30:00.000Z");
  });

  it("refuses what is not a schedule", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of 0-59/);
    expect(() => parseCron("x * * * *")).toThrow(/bad minute/);
    expect(() => parseCron("0 0 31 2 *")).not.toThrow();
    expect(() => nextRun(parseCron("0 0 31 2 *"), "UTC", at("2026-10-19T00:00:00Z"))).toThrow(/never comes round/);
    expect(() => checkZone("Mars/Base")).toThrow(/unknown time zone/);
  });
});
