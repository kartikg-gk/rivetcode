import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor, realProbes, type Probes } from "../src/cli/doctor.js";
import { runCli } from "../src/cli/commands.js";
import { makeDataDir, removeRepo } from "./helpers.js";

let data: string;
beforeEach(async () => { data = await makeDataDir(); });
afterEach(async () => { await removeRepo(data); });

const healthy = (over: Partial<Probes> = {}): Probes => realProbes({
  nodeVersion: "24.14.0",
  run: async (file) => (file === "git" ? "git version 2.53.0.windows.2" : `${file} 1.2.3`),
  findClaude: () => "/bin/claude",
  findCodex: () => "/bin/codex",
  loadPty: () => true,
  daemonUp: async () => true,
  githubToken: async () => "t",
  cliBuilt: () => true,
  now: () => Date.parse("2026-10-13T12:00:00Z"),
  ...over,
});

const byName = async (p: Probes) => Object.fromEntries((await doctor(data, p)).map((c) => [c.name, c]));

describe("doctor", () => {
  it("passes everything on a healthy machine", async () => {
    const checks = await doctor(data, healthy());
    expect(checks.map((c) => [c.name, c.level])).toEqual([
      ["node", "ok"], ["git", "ok"], ["data dir", "ok"], ["build", "ok"], ["daemon", "ok"],
      ["terminals", "ok"], ["claude", "ok"], ["codex", "ok"], ["github", "ok"], ["hooks", "ok"],
    ]);
    expect(checks.find((c) => c.name === "claude")!.message).toBe("/bin/claude 1.2.3 (/bin/claude)");
  });

  it("fails what blocks Rivet and warns about what only degrades it", async () => {
    const c = await byName(healthy({
      nodeVersion: "22.1.0",
      run: async (file) => { if (file === "git") return "git version 2.30.1"; throw new Error("no"); },
      findCodex: () => { throw new Error("codex was not found"); },
      loadPty: () => false,
      daemonUp: async () => false,
      githubToken: async () => { throw new Error("no GitHub token"); },
      cliBuilt: () => false,
    }));
    expect(c.node).toMatchObject({ level: "fail", message: expect.stringMatching(/Node 24/) });
    expect(c.git).toMatchObject({ level: "warn", message: expect.stringMatching(/radar needs 2\.38/) });
    expect(c.build).toMatchObject({ level: "fail", message: expect.stringMatching(/npm run build/) });
    expect(c.daemon.level).toBe("warn");
    expect(c.terminals.level).toBe("warn");
    expect(c.claude).toMatchObject({ level: "warn", message: expect.stringMatching(/does not answer --version/) });
    expect(c.codex).toMatchObject({ level: "warn", message: expect.stringMatching(/codex was not found/) });
    expect(c.github.level).toBe("warn");
  });

  it("fails without git and reports recent hook failures", async () => {
    await writeFile(join(data, "hooks.log"), [
      "2026-10-11T00:00:00.000Z claude-code stop r1-a old failure",
      "2026-10-13T11:00:00.000Z claude-code stop r1-a rivet daemon is not running",
    ].join("\n"));
    const c = await byName(healthy({ run: async () => { throw new Error("missing"); } }));
    expect(c.git.level).toBe("fail");
    expect(c.hooks).toMatchObject({ level: "warn", message: expect.stringMatching(/^1 hook failures in the last day/) });
  });

  it("rivet doctor prints one line per check and exits 1 on a failure", async () => {
    const out: string[] = [];
    const io = { env: { RIVET_DATA_DIR: data, RIVET_RUN_FILE: join(data, "none.json") }, cwd: data, readStdin: async () => "", out: (l: string) => out.push(l), err: () => {} };
    expect(await runCli(["doctor"], { ...io, doctorProbes: healthy() })).toBe(0);
    expect(out[0]).toMatch(/^ok +node +24\.14\.0$/);
    out.length = 0;
    expect(await runCli(["doctor"], { ...io, doctorProbes: healthy({ cliBuilt: () => false }) })).toBe(1);
    expect(out.join("\n")).toMatch(/^FAIL +build/m);
  });
});
