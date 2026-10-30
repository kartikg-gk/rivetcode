import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/agents/agent.js";
import { agentEnv, rivetBinDir } from "../src/runtime/env.js";
import { createRuntime, RuntimeError, type Runtime } from "../src/runtime/runtime.js";
import { makeDataDir, removeRepo } from "./helpers.js";

let data: string;
let ws: string;
let runtime: Runtime;

beforeEach(async () => {
  data = await makeDataDir();
  ws = join(data, "work space");
  await mkdir(ws);
  runtime = createRuntime({ logDir: join(data, "logs"), stopGraceMs: 500 });
});

afterEach(async () => {
  await runtime.stopAll();
  await removeRepo(data);
});

async function fakeArgv(spec: object): Promise<string[]> {
  return getAgent("fake").launchCommand({ sessionId: "r1-a", workspace: ws, prompt: JSON.stringify(spec) });
}

function exited(sessionId: string): Promise<number | null> {
  return new Promise((resolve) => {
    const off = runtime.onExit((id, _launch, code) => {
      if (id === sessionId) { off(); resolve(code); }
    });
  });
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("start", () => {
  it("runs the command in the workspace with the given env, no shell", async () => {
    const done = exited("r1-a");
    const launch = await runtime.start({
      sessionId: "r1-a", workspace: ws, argv: await fakeArgv({ dumpEnv: true, files: { "a b.txt": "x" } }),
      env: { RIVET_SESSION_ID: "r1-a" },
    });
    expect(launch.launchId).toMatch(/^[0-9a-f]{16}$/);
    expect(await done).toBe(0);
    expect(JSON.parse(await readFile(join(ws, "env.json"), "utf8"))).toEqual({ RIVET_SESSION_ID: "r1-a" });
    expect(existsSync(join(ws, "a b.txt"))).toBe(true);
  });

  it("gives the agent a PATH that starts with Rivet's bin folder", async () => {
    const done = exited("r1-a");
    const env = agentEnv({ runId: "r1", nodeId: "a", project: "p", dataDir: data, runFile: "f", launchId: "x" });
    await runtime.start({
      sessionId: "r1-a", workspace: ws, env,
      argv: [process.execPath, "-e", "const k = Object.keys(process.env).filter((n) => n.toUpperCase() === 'PATH'); console.log(k.length, process.env[k[0]].split(require('path').delimiter)[0])"],
    });
    await done;
    expect(runtime.output("r1-a", 1)!.lines).toEqual([`1 ${rivetBinDir()}`]);
  });

  it("refuses a second start while the session is live", async () => {
    await runtime.start({ sessionId: "r1-a", workspace: ws, argv: await fakeArgv({ stayFor: 5000 }), env: {} });
    await expect(runtime.start({ sessionId: "r1-a", workspace: ws, argv: await fakeArgv({}), env: {} }))
      .rejects.toThrow(/already running/);
  });

  it("refuses a second start issued in the same moment", async () => {
    const argv = await fakeArgv({ stayFor: 5000 });
    const results = await Promise.allSettled([
      runtime.start({ sessionId: "r1-a", workspace: ws, argv, env: {} }),
      runtime.start({ sessionId: "r1-a", workspace: ws, argv, env: {} }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(runtime.liveSessions()).toEqual(["r1-a"]);
  });

  it("refuses a missing workspace or a command that does not exist", async () => {
    await expect(runtime.start({ sessionId: "r1-a", workspace: join(data, "nope"), argv: await fakeArgv({}), env: {} }))
      .rejects.toThrow(RuntimeError);
    await expect(runtime.start({ sessionId: "r1-b", workspace: ws, argv: ["rivet-no-such-binary"], env: {} }))
      .rejects.toThrow(/could not start/);
    expect(runtime.isAlive("r1-b")).toBe(false);
  });

  it("can start the same session again after it exited", async () => {
    let done = exited("r1-a");
    const first = await runtime.start({ sessionId: "r1-a", workspace: ws, argv: await fakeArgv({}), env: {} });
    await done;
    done = exited("r1-a");
    const second = await runtime.start({ sessionId: "r1-a", workspace: ws, argv: await fakeArgv({}), env: {} });
    await done;
    expect(second.launchId).not.toBe(first.launchId);
  });
});

describe("output", () => {
  it("keeps the last lines after exit and appends them to the session log", async () => {
    const done = exited("r1-a");
    await runtime.start({
      sessionId: "r1-a", workspace: ws, argv: await fakeArgv({ files: { "1": "", "2": "", "3": "" }, exitCode: 2 }), env: {},
    });
    expect(await done).toBe(2);
    expect(runtime.output("r1-a", 2)).toEqual({ alive: false, exitCode: 2, lines: ["wrote 2", "wrote 3"] });
    const log = await readFile(join(data, "logs", "r1-a.log"), "utf8");
    expect(log.split(/\r?\n/).filter(Boolean)).toEqual(["wrote 1", "wrote 2", "wrote 3"]);
  });

  it("caps the lines kept in memory", async () => {
    const small = createRuntime({ logDir: join(data, "logs"), keepLines: 2 });
    const done = new Promise<void>((r) => small.onExit(() => r()));
    await small.start({ sessionId: "r1-a", workspace: ws, argv: await fakeArgv({ files: { "1": "", "2": "", "3": "" } }), env: {} });
    await done;
    expect(small.output("r1-a", 100)!.lines).toEqual(["wrote 2", "wrote 3"]);
  });

  it("returns null for a session it never started, and after forget", async () => {
    expect(runtime.output("r1-x", 10)).toBeNull();
    const done = exited("r1-a");
    await runtime.start({ sessionId: "r1-a", workspace: ws, argv: await fakeArgv({}), env: {} });
    await done;
    runtime.forget("r1-a");
    expect(runtime.output("r1-a", 10)).toBeNull();
  });
});

describe("write", () => {
  it("types a line into the agent's input", async () => {
    await runtime.start({ sessionId: "r1-a", workspace: ws, argv: await fakeArgv({ listen: true }), env: {} });
    await runtime.write("r1-a", "hello there");
    await until(() => existsSync(join(ws, "inbox.txt")));
    expect(await readFile(join(ws, "inbox.txt"), "utf8")).toBe("hello there\n");
    const done = exited("r1-a");
    await runtime.write("r1-a", "/exit");
    await done;
    await expect(runtime.write("r1-a", "late")).rejects.toThrow(/not running/);
  });
});

describe("stop", () => {
  it("ends a running agent and is safe to repeat", async () => {
    await runtime.start({ sessionId: "r1-a", workspace: ws, argv: await fakeArgv({ stayFor: 60_000 }), env: {} });
    await runtime.stop("r1-a");
    expect(runtime.isAlive("r1-a")).toBe(false);
    await runtime.stop("r1-a");
    await runtime.stop("r1-never");
  });

  it("force-kills an agent that ignores the polite request", async () => {
    const stubborn = [process.execPath, "-e", "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)"];
    await runtime.start({ sessionId: "r1-a", workspace: ws, argv: stubborn, env: {} });
    await until(() => (runtime.output("r1-a", 1)?.lines ?? []).includes("up"));
    const started = Date.now();
    await runtime.stop("r1-a");
    expect(runtime.isAlive("r1-a")).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("stopAll ends every live agent", async () => {
    await runtime.start({ sessionId: "r1-a", workspace: ws, argv: await fakeArgv({ stayFor: 60_000 }), env: {} });
    await runtime.start({ sessionId: "r1-b", workspace: ws, argv: await fakeArgv({ stayFor: 60_000 }), env: {} });
    expect(runtime.liveSessions().sort()).toEqual(["r1-a", "r1-b"]);
    await runtime.stopAll();
    expect(runtime.liveSessions()).toEqual([]);
  });
});

describe("stop reaches child processes", () => {
  it("ends processes the agent started", async () => {
    const pidFile = join(ws, "grandchild.pid");
    const script = `const { spawn } = require('child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)`;
    await runtime.start({ sessionId: "r1-a", workspace: ws, argv: [process.execPath, "-e", script], env: {} });
    await until(() => existsSync(pidFile));
    const grandchild = Number(await readFile(pidFile, "utf8"));
    await runtime.stop("r1-a");
    await until(() => { try { process.kill(grandchild, 0); return false; } catch { return true; } });
  });
});

describe("closed stdin", () => {
  it("gives the agent no input and refuses writes", async () => {
    const done = exited("r1-a");
    await runtime.start({
      sessionId: "r1-a", workspace: ws, env: {}, stdin: "ignore",
      argv: [process.execPath, "-e", "process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('eof')); setTimeout(() => {}, 300)"],
    });
    await expect(runtime.write("r1-a", "hello")).rejects.toThrow(/does not take input/);
    await done;
    expect(runtime.output("r1-a", 5)!.lines).toContain("eof");
  });
});

describe("terminal sessions", () => {
  // Echoes every key it gets, quits on "q".
  const ECHO = [
    "process.stdout.write('tty=' + process.stdout.isTTY + ' cols=' + process.stdout.columns + String.fromCharCode(10));",
    "process.stdin.setRawMode(true);",
    "process.stdin.on('data', (d) => { const s = d.toString(); if (s.includes('q')) process.exit(0); process.stdout.write('[' + JSON.stringify(s) + ']'); });",
  ].join("\n");

  it("runs in a real terminal, takes typed lines and raw keys, and resizes", async () => {
    const script = join(ws, "echo.js");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(script, ECHO);
    const launch = await runtime.start({ sessionId: "r1-t", workspace: ws, argv: [process.execPath, script], env: {}, terminal: { cols: 100, rows: 30 } });
    expect(launch.launchId).toBeTruthy();
    await until(() => (runtime.output("r1-t", 5)?.lines ?? []).some((l) => l.includes("tty=true cols=100")));
    const seen: string[] = [];
    const attached = runtime.attach("r1-t", (c) => seen.push(c))!;
    expect(attached.replay).toContain("tty=true");
    await runtime.write("r1-t", "hi");
    // The text first, then the Enter that submits it on its own, so a terminal app does
    // not take the Enter as part of a paste.
    await until(() => seen.join("").includes('"hi"') && seen.join("").includes('"\\r"'));
    expect(seen.join("")).not.toContain('"hi\\r"');
    runtime.resize("r1-t", 120, 40);
    const done = exited("r1-t");
    runtime.input("r1-t", "q");
    expect(await done).toBe(0);
    attached.detach();
  });

  it("refuses raw input to a piped session", async () => {
    await runtime.start({ sessionId: "r1-p", workspace: ws, argv: await fakeArgv({ stayFor: 5000 }), env: {} });
    expect(() => runtime.input("r1-p", "x")).toThrow(/no terminal/);
  });

  it("stops a terminal session", async () => {
    await runtime.start({ sessionId: "r1-s", workspace: ws, argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], env: {}, terminal: { cols: 80, rows: 24 } });
    await runtime.stop("r1-s");
    expect(runtime.isAlive("r1-s")).toBe(false);
  });
});


it("gives an actual pseudo-terminal a usable TERM when its parent is dumb",async()=>{
 const done=exited("r1-term");await runtime.start({sessionId:"r1-term",workspace:ws,argv:[process.execPath,"-e","console.log(process.env.TERM)"],env:{TERM:"dumb"},terminal:{cols:80,rows:24}});expect(await done).toBe(0);expect(runtime.output("r1-term",10)?.lines.join("\n")).toContain("xterm-256color");
});
