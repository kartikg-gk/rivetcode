import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITIGNORE_MARKER, ignoreHookFiles, hooksManager } from "../src/agents/hooks.js";
import { git } from "../src/git.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";
import { worktreePath } from "../src/paths.js";
import { makeDataDir, makeRepo, removeRepo } from "./helpers.js";

const manager = hooksManager({
  label: "test-agent",
  prefix: "rivet hooks test-agent ",
  timeout: 30,
  path: (ws) => join(ws, ".agent", "settings.json"),
  managed: [
    { event: "SessionStart", matcher: "startup|resume", command: "rivet hooks test-agent session-start" },
    { event: "Stop", command: "rivet hooks test-agent stop" },
  ],
});

let ws: string;
const file = () => join(ws, ".agent", "settings.json");
const read = async () => JSON.parse(await readFile(file(), "utf8"));

beforeEach(async () => { ws = await makeDataDir(); });
afterEach(async () => { await removeRepo(ws); });

describe("install", () => {
  it("writes the managed hooks into a fresh file", async () => {
    await manager.install(ws);
    expect(await read()).toEqual({
      hooks: {
        SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "rivet hooks test-agent session-start", timeout: 30 }] }],
        Stop: [{ hooks: [{ type: "command", command: "rivet hooks test-agent stop", timeout: 30 }] }],
      },
    });
    expect((await readFile(file(), "utf8")).endsWith("}\n")).toBe(true);
  });

  it("keeps the user's own hooks, settings and unknown fields", async () => {
    await mkdir(join(ws, ".agent"));
    await writeFile(file(), JSON.stringify({
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo mine", timeout: 5, note: "keep" }], extra: 1 }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
      },
    }));

    await manager.install(ws);

    const data = await read();
    expect(data.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(data.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }]);
    expect(data.hooks.Stop).toEqual([{
      extra: 1,
      hooks: [
        { type: "command", command: "echo mine", timeout: 5, note: "keep" },
        { type: "command", command: "rivet hooks test-agent stop", timeout: 30 },
      ],
    }]);
  });

  it("does not duplicate on re-install", async () => {
    await manager.install(ws);
    const once = await readFile(file(), "utf8");
    await manager.install(ws);
    expect(await readFile(file(), "utf8")).toBe(once);
  });

  it("names the file when it is not valid JSON", async () => {
    await mkdir(join(ws, ".agent"));
    await writeFile(file(), "{ nope");
    await expect(manager.install(ws)).rejects.toThrow(/settings\.json/);
  });
});

describe("uninstall and installed", () => {
  it("removes only Rivet's hooks", async () => {
    await mkdir(join(ws, ".agent"));
    await writeFile(file(), JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
    await manager.install(ws);
    expect(await manager.installed(ws)).toBe(true);

    await manager.uninstall(ws);

    expect(await read()).toEqual({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } });
    expect(await manager.installed(ws)).toBe(false);
  });

  it("drops the hooks key when nothing is left", async () => {
    await manager.install(ws);
    await manager.uninstall(ws);
    expect(await read()).toEqual({});
  });

  it("does nothing when there is no file", async () => {
    await manager.uninstall(ws);
    expect(existsSync(file())).toBe(false);
    expect(await manager.installed(ws)).toBe(false);
  });
});

describe("hook files stay out of git", () => {
  it("writes a marked .gitignore next to the hook file", async () => {
    await manager.install(ws);
    expect(await readFile(join(ws, ".agent", ".gitignore"), "utf8")).toBe(
      `${GITIGNORE_MARKER}\n/.gitignore\n/settings.json\n`,
    );
  });

  it("never overwrites a .gitignore the user wrote", async () => {
    await mkdir(join(ws, ".agent"));
    await writeFile(join(ws, ".agent", ".gitignore"), "mine\n");
    await ignoreHookFiles(join(ws, ".agent"), "settings.json");
    expect(await readFile(join(ws, ".agent", ".gitignore"), "utf8")).toBe("mine\n");
  });

  it("leaves a real worktree's git status clean", async () => {
    const repo = await makeRepo();
    const data = await makeDataDir();
    try {
      const path = worktreePath(data, "proj", "r1", "root");
      await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
      await manager.install(path);
      expect((await git(["status", "--porcelain"], path)).trim()).toBe("");
      await removeWorktree(data, repo, path);
    } finally {
      await removeRepo(repo);
      await removeRepo(data);
    }
  });
});

describe("edge cases", () => {
  const write = async (value: unknown) => {
    await mkdir(join(ws, ".agent"), { recursive: true });
    await writeFile(file(), typeof value === "string" ? value : JSON.stringify(value));
  };

  it("requires a workspace for every operation", async () => {
    await expect(manager.install(" ")).rejects.toThrow(/test-agent.*workspace is required/);
    await expect(manager.uninstall("")).rejects.toThrow(/test-agent.*workspace is required/);
    await expect(manager.installed("")).rejects.toThrow(/test-agent.*workspace is required/);
  });

  it.each([
    ["an event that is not a list", { hooks: { Stop: { oops: 1 } } }, /parse Stop hooks/],
    ["a group whose hooks is not a list", { hooks: { Stop: [{ hooks: "x" }] } }, /parse Stop hooks/],
    ["a top level that is not an object", [], /expected a JSON object/],
    ["hooks that is not an object", { hooks: [] }, /parse hooks/],
  ])("refuses %s and leaves the file untouched", async (_name, value, message) => {
    await write(value);
    const before = await readFile(file(), "utf8");
    await expect(manager.install(ws)).rejects.toThrow(message);
    await expect(manager.install(ws)).rejects.toThrow(/test-agent/);
    expect(await readFile(file(), "utf8")).toBe(before);
  });

  it("treats an empty file as no settings", async () => {
    await write("  \n");
    await manager.install(ws);
    expect(Object.keys((await read()).hooks)).toEqual(["SessionStart", "Stop"]);
  });

  it("treats \"matcher\": null like no matcher and keeps the group's fields", async () => {
    await write({ hooks: { Stop: [{ matcher: null, keep: 1, hooks: [{ type: "command", command: "rivet hooks test-agent stop" }] }] } });
    await manager.install(ws);
    expect((await read()).hooks.Stop).toEqual([
      { keep: 1, hooks: [{ type: "command", command: "rivet hooks test-agent stop", timeout: 30 }] },
    ]);
  });

  it("keeps the first duplicate's extra fields", async () => {
    await write({ hooks: { Stop: [
      { hooks: [{ type: "command", command: "rivet hooks test-agent stop", a: 1 }] },
      { hooks: [{ type: "command", command: "rivet hooks test-agent stop", b: 2 }] },
    ] } });
    await manager.install(ws);
    expect((await read()).hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "rivet hooks test-agent stop", a: 1, timeout: 30 }] },
    ]);
  });

  it("moves the hook when its matcher changes", async () => {
    await write({ hooks: { SessionStart: [{ matcher: "old", hooks: [{ type: "command", command: "rivet hooks test-agent session-start" }] }] } });
    await manager.install(ws);
    expect((await read()).hooks.SessionStart).toEqual([
      { matcher: "startup|resume", hooks: [{ type: "command", command: "rivet hooks test-agent session-start", timeout: 30 }] },
    ]);
  });

  it("drops Rivet hooks it no longer manages and keeps the user's", async () => {
    await write({ hooks: { Stop: [{ hooks: [
      { type: "command", command: "rivet hooks test-agent old-event" },
      { type: "command", command: "echo mine" },
    ] }] } });
    await manager.install(ws);
    expect((await read()).hooks.Stop).toEqual([{ hooks: [
      { type: "command", command: "echo mine" },
      { type: "command", command: "rivet hooks test-agent stop", timeout: 30 },
    ] }]);
  });

  it("omits a zero timeout", async () => {
    const zero = hooksManager({ label: "z", prefix: "rivet hooks z ", timeout: 0, path: (w) => join(w, "s.json"), managed: [{ event: "Stop", command: "rivet hooks z stop" }] });
    await zero.install(ws);
    expect(JSON.parse(await readFile(join(ws, "s.json"), "utf8")).hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "rivet hooks z stop" });
  });

  it("refreshes a .gitignore it owns", async () => {
    await mkdir(join(ws, ".agent"), { recursive: true });
    await writeFile(join(ws, ".agent", ".gitignore"), `${GITIGNORE_MARKER}\n/old\n`);
    await ignoreHookFiles(join(ws, ".agent"), "settings.json");
    expect(await readFile(join(ws, ".agent", ".gitignore"), "utf8")).toBe(`${GITIGNORE_MARKER}\n/.gitignore\n/settings.json\n`);
  });
});
