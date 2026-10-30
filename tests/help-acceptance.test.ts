import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli/commands.js";

// `rivet --help` must answer without a daemon: a user asking for help may have none running.
describe("rivet --help", () => {
  it("exits 0, prints usage with switch and read, and never starts the daemon", async () => {
    const out: string[] = [];
    const err: string[] = [];
    let started = false;
    const io: CliIo = {
      env: { RIVET_DATA_DIR: "unused" },
      cwd: process.cwd(),
      readStdin: async () => "",
      startDaemon: async () => {
        started = true;
        throw new Error("--help must not start the daemon");
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };

    expect(await runCli(["--help"], io)).toBe(0);
    const usage = out.join("\n");
    expect(usage).toMatch(/^usage: rivet <command>/);
    expect(usage).toMatch(/^\s+switch <run> claude\|codex/m);
    expect(usage).toMatch(/^\s+read <run> /m);
    expect(err).toEqual([]);
    expect(started).toBe(false);
  });
});
