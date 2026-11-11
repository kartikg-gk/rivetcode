import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCandidates, findClaude, findCodex, findDelta } from "../src/agents/locate.js";
import { makeDataDir, removeRepo } from "./helpers.js";

let dir: string;
beforeEach(async () => { dir = await makeDataDir(); });
afterEach(async () => { await removeRepo(dir); });

async function touch(...parts: string[]): Promise<string> {
  const path = join(dir, ...parts);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "");
  return path;
}

describe("findClaude", () => {
  it("prefers the PATH, in Windows name order", async () => {
    const cmd = await touch("bin", "claude.cmd");
    const exe = await touch("bin", "claude.exe");
    expect(findClaude({ platform: "win32", env: { PATH: join(dir, "bin") }, home: dir })).toBe(exe);
    expect(cmd).toBeTruthy();
  });

  it("unwraps an npm .cmd shim to the real executable", async () => {
    await touch("npm", "claude.cmd");
    const real = await touch("npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    expect(findClaude({ platform: "win32", env: { PATH: join(dir, "npm") }, home: dir })).toBe(real);
  });

  it("falls back to install locations when PATH has none", async () => {
    const native = await touch(".local", "bin", "claude.exe");
    expect(findClaude({ platform: "win32", env: { PATH: "" }, home: dir })).toBe(native);
    const appData = await touch("roaming", "npm", "claude.exe");
    expect(findClaude({ platform: "win32", env: { PATH: "", APPDATA: join(dir, "roaming") }, home: join(dir, "nobody") })).toBe(appData);
  });

  // A unix PATH cannot hold Windows drive paths, so this half only runs on unix hosts.
  it.skipIf(process.platform === "win32")("finds claude on a unix PATH", async () => {
    const onPath = await touch("ubin", "claude");
    expect(findClaude({ platform: "linux", env: { PATH: [join(dir, "nope"), join(dir, "ubin")].join(delimiter) }, home: dir })).toBe(onPath);
  });

  it("knows the unix install paths", () => {
    expect(claudeCandidates({ platform: "darwin", env: { PATH: "" }, home: "/h" })).toEqual(expect.arrayContaining([
      "/usr/local/bin/claude", "/opt/homebrew/bin/claude", join("/h", ".claude", "local", "claude"), join("/h", ".local", "bin", "claude"),
    ]));
  });

  it("says clearly when claude is not installed", () => {
    expect(() => findClaude({ platform: "linux", env: { PATH: "" }, home: dir }))
      .toThrow(/claude was not found/);
  });

  it("honours an explicit RIVET_CLAUDE_BIN", async () => {
    const custom = await touch("custom", "my-claude");
    expect(findClaude({ platform: "linux", env: { PATH: "", RIVET_CLAUDE_BIN: custom }, home: dir })).toBe(custom);
  });
});

describe("findCodex", () => {
  it("finds codex on the PATH, skipping Windows Store aliases", async () => {
    const alias = await touch("WindowsApps", "codex.exe");
    const real = await touch("OpenAI", "codex.exe");
    expect(findCodex({ platform: "win32", env: { PATH: [join(dir, "WindowsApps"), join(dir, "OpenAI")].join(";") }, home: dir })).toBe(real);
    expect(alias).toBeTruthy();
  });

  it("prefers npm's native executable and unwraps the shim", async () => {
    await touch("roaming", "npm", "codex.cmd");
    const native = await touch("roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.exe");
    expect(findCodex({ platform: "win32", env: { PATH: "", APPDATA: join(dir, "roaming") }, home: dir })).toBe(native);
  });

  it("says clearly when codex is missing", () => {
    expect(() => findCodex({ platform: "linux", env: { PATH: "" }, home: dir })).toThrow(/codex was not found/);
  });
});

describe("findDelta", () => {
  it("takes the first delta that has the rpc mode, skipping an older one", async () => {
    const old = await touch("old", "delta.exe");
    const fresh = await touch("fresh", "delta.exe");
    const asked: string[] = [];
    const found = findDelta({ platform: "win32", env: { PATH: [join(dir, "old"), join(dir, "fresh")].join(";") }, home: dir }, (b) => { asked.push(b); return b === fresh; });
    expect(found).toBe(fresh);
    expect(asked).toEqual([old, fresh]);
  });

  it("looks in ~/.local/bin, where pipx and uv put tools", async () => {
    const tool = await touch(".local", "bin", "delta");
    expect(findDelta({ platform: "linux", env: { PATH: "" }, home: dir }, () => true)).toBe(tool);
  });

  it("says when every delta found is too old, and when there is none", async () => {
    const old = await touch("only", "delta.exe");
    expect(() => findDelta({ platform: "win32", env: { PATH: join(dir, "only") }, home: join(dir, "nohome") }, () => false)).toThrow(`${old} is a delta without --mode rpc`);
    expect(() => findDelta({ platform: "win32", env: { PATH: join(dir, "none") }, home: join(dir, "nohome") }, () => true)).toThrow("delta was not found");
  });

  it("uses RIVET_DELTA_BIN as given", async () => {
    const mine = await touch("mine", "delta");
    expect(findDelta({ platform: "linux", env: { RIVET_DELTA_BIN: mine }, home: dir }, () => false)).toBe(mine);
  });
});
