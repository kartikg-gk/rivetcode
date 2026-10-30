import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli/commands.js";

// `rivet --help` and `rivet help` must answer without a daemon: a user asking for help may have none running.
// A bare `rivet` stays a usage error (exit 2) and prints usage to stderr.
describe("rivet --help", () => {
  function helpIo(out: string[], err: string[], started: { value: boolean }): CliIo {
    return {
      env: { RIVET_DATA_DIR: "unused" },
      cwd: process.cwd(),
      readStdin: async () => "",
      startDaemon: async () => {
        started.value = true;
        throw new Error("--help must not start the daemon");
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };
  }

  it.each([["--help"], ["help"]])("%s exits 0, prints usage with switch and read, and never starts the daemon", async (flag) => {
    const out: string[] = [];
    const err: string[] = [];
    const started = { value: false };

    expect(await runCli([flag], helpIo(out, err, started))).toBe(0);
    const usage = out.join("\n");
    expect(usage).toMatch(/^usage: rivet <command>/);
    expect(usage).toMatch(/^\s+switch <run> claude\|codex/m);
    expect(usage).toMatch(/^\s+read <run> /m);
    expect(err).toEqual([]);
    expect(started.value).toBe(false);
  });

  it("keeps a bare rivet a usage error that prints usage to stderr", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const started = { value: false };

    expect(await runCli([], helpIo(out, err, started))).toBe(2);
    expect(err.join("\n")).toMatch(/usage: rivet/);
    expect(started.value).toBe(false);
  });
});
