import { spawnSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  liveOwner,
  readRunFile,
  releaseRunFile,
  runFileAt,
  writeRunFile,
} from "../src/runfile.js";
import { makeDataDir, removeRepo } from "./helpers.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await makeDataDir();
  file = join(dir, "running.json");
});
afterEach(async () => { await removeRepo(dir); });

const info = (pid: number) => ({ pid, port: 4711, startedAt: "2026-09-30T10:00:00.000Z" });

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(child.stdout.toString());
}

describe("runFileAt", () => {
  const saved = process.env.RIVET_RUN_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.RIVET_RUN_FILE;
    else process.env.RIVET_RUN_FILE = saved;
  });

  it("defaults to ~/.rivet/running.json", () => {
    delete process.env.RIVET_RUN_FILE;
    expect(runFileAt()).toBe(join(homedir(), ".rivet", "running.json"));
  });

  it("uses RIVET_RUN_FILE when set, made absolute against the current folder", () => {
    process.env.RIVET_RUN_FILE = join(homedir(), "x", "run.json");
    expect(runFileAt()).toBe(join(homedir(), "x", "run.json"));
    process.env.RIVET_RUN_FILE = "rel/run.json";
    expect(runFileAt()).toBe(resolve("rel/run.json"));
  });
});

describe("run file", () => {
  it("round-trips and leaves no temp files", async () => {
    await writeRunFile(file, info(123));
    expect(await readRunFile(file)).toEqual(info(123));
    expect(await readdir(dir)).toEqual(["running.json"]);
  });

  it("reads a missing file as no daemon", async () => {
    expect(await readRunFile(file)).toBeNull();
  });

  it("rejects a file that is not valid JSON", async () => {
    await writeFile(file, "{");
    await expect(readRunFile(file)).rejects.toThrow(/parse run file/);
  });

  it("only removes the file for its owner", async () => {
    await writeRunFile(file, info(123));
    await releaseRunFile(file, 999);
    expect(await readRunFile(file)).not.toBeNull();
    await releaseRunFile(file, 123);
    expect(await readRunFile(file)).toBeNull();
    await releaseRunFile(file, 123);
  });
});

describe("liveOwner", () => {
  it("returns nothing when no file exists", async () => {
    expect(await liveOwner(file)).toBeNull();
  });

  it("reports a live owner", async () => {
    await writeRunFile(file, info(process.pid));
    expect(await liveOwner(file)).toEqual(info(process.pid));
  });

  it("treats a dead owner as stale", async () => {
    await writeRunFile(file, info(deadPid()));
    expect(await liveOwner(file)).toBeNull();
  });
});
