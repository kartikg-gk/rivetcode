// Cron schedules ("minute hour day-of-month month day-of-week") in an IANA time zone.

export class CronError extends Error {}

type Field = Set<number>;
export type Cron = { minute: Field; hour: Field; day: Field; month: Field; weekday: Field; anyDay: boolean; anyWeekday: boolean };

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES = ["minute", "hour", "day of month", "month", "day of week"];

function field(text: string, i: number): Field {
  const [lo, hi] = RANGES[i]!;
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`bad ${NAMES[i]} "${part}"`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === "*" ? lo : Number(m[2]);
    const to = m[1] === "*" ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from;
    if (step < 1 || from < lo || to > hi || from > to) throw new CronError(`${NAMES[i]} "${part}" is out of ${lo}-${hi}`);
    for (let v = from; v <= to; v += step) out.add(i === 4 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`a cron schedule has 5 fields (minute hour day month weekday), got ${parts.length}`);
  const [minute, hour, day, month, weekday] = parts.map((p, i) => field(p, i)) as Field[];
  return { minute: minute!, hour: hour!, day: day!, month: month!, weekday: weekday!, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

export function checkZone(zone: string): void {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { throw new CronError(`unknown time zone "${zone}"`); }
}

// One formatter per zone: building one is far slower than using it.
const formatters = new Map<string, Intl.DateTimeFormat>();

// The wall clock in a zone at an instant.
function wall(at: Date, zone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short",
    });
    formatters.set(zone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!),
  };
}

function matches(c: Cron, w: ReturnType<typeof wall>): boolean {
  if (!c.minute.has(w.minute) || !c.hour.has(w.hour) || !c.month.has(w.month)) return false;
  // As in cron: with both day fields restricted, either may match.
  const day = c.day.has(w.day);
  const weekday = c.weekday.has(w.weekday);
  if (c.anyDay && c.anyWeekday) return true;
  if (c.anyDay) return weekday;
  if (c.anyWeekday) return day;
  return day || weekday;
}

// The first minute strictly after `after` that the schedule names, within about a year.
export function nextRun(cron: Cron, zone: string, after: Date): Date {
  let t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 370 * 24 * 60; i++) {
    const w = wall(t, zone);
    if (!hourCanMatch(cron, w)) {
      // Skip to the next hour boundary when this hour cannot match.
      t = new Date(t.getTime() + (60 - w.minute) * 60_000);
      continue;
    }
    if (matches(cron, w)) return t;
    t = new Date(t.getTime() + 60_000);
  }
  throw new CronError("the schedule never comes round within a year");
}

function hourCanMatch(c: Cron, w: ReturnType<typeof wall>): boolean {
  return c.hour.has(w.hour) && c.month.has(w.month);
}
