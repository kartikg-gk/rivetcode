import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent } from "../src/agents/agent.js";
import { CLAUDE_HOOKS } from "../src/agents/claude.js";
import { git } from "../src/git.js";
import { worktreePath } from "../src/paths.js";
import { createWorktree, removeWorktree, waitForTrash } from "../src/worktree.js";
import { makeDataDir, makeRepo, removeRepo } from "./helpers.js";

describe("registry", () => {
  it("rejects an unknown agent", () => {
    expect(() => getAgent("gpt" as never)).toThrow(/unknown agent "gpt"/);
  });
});

describe("claude adapter", () => {
  const claude = getAgent("claude");
  let ws: string;
  beforeEach(async () => { ws = await makeDataDir(); });
  afterEach(async () => { await removeRepo(ws); });

  it("delivers the prompt in the launch command", async () => {
    expect(claude.promptVia).toBe("argv");
    expect(await claude.launchCommand({ sessionId: "r1-root.1", workspace: ws, prompt: "fix it" })).toEqual([
      "claude", "--session-id", "cce53ecb-99f4-55ff-a3cb-693ccbf24d77", "--", "fix it",
    ]);
  });

  it("uses a configured binary", async () => {
    const custom = getAgent("claude", { binary: "C:\\tools\\claude.exe" });
    expect((await custom.launchCommand({ sessionId: "r1-root", workspace: ws }))[0]).toBe("C:\\tools\\claude.exe");
  });

  it("can resume from the derived session id", async () => {
    expect(await claude.restoreCommand({ sessionId: "r1-root.1", workspace: ws })).toEqual([
      "claude", "--resume", "cce53ecb-99f4-55ff-a3cb-693ccbf24d77",
    ]);
  });

  it("installs the ten Claude Code hooks into .claude/settings.local.json", async () => {
    await claude.installHooks(ws);
    const settings = JSON.parse(await readFile(join(ws, ".claude", "settings.local.json"), "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "Notification", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "PreToolUse",
      "SessionEnd", "SessionStart", "Stop", "SubagentStop", "UserPromptSubmit",
    ]);
    expect(settings.hooks.SessionStart).toEqual([{
      matcher: "startup|resume|clear|compact|fork",
      hooks: [{ type: "command", command: "rivet hooks claude-code session-start", timeout: 30 }],
    }]);
    const pinned = Object.fromEntries(
      Object.entries(settings.hooks as Record<string, { matcher?: string; hooks: { command: string }[] }[]>)
        .map(([event, groups]) => [event, [groups[0]!.matcher ?? null, groups[0]!.hooks[0]!.command]]),
    );
    expect(pinned).toEqual({
      SessionStart: ["startup|resume|clear|compact|fork", "rivet hooks claude-code session-start"],
      UserPromptSubmit: [null, "rivet hooks claude-code user-prompt-submit"],
      PreToolUse: [null, "rivet hooks claude-code pre-tool-use"],
      PostToolUse: [null, "rivet hooks claude-code post-tool-use"],
      PostToolUseFailure: [null, "rivet hooks claude-code post-tool-use-failure"],
      PermissionRequest: [null, "rivet hooks claude-code permission-request"],
      Stop: [null, "rivet hooks claude-code stop"],
      Notification: [null, "rivet hooks claude-code notification"],
      SubagentStop: [null, "rivet hooks claude-code subagent-stop"],
      SessionEnd: [null, "rivet hooks claude-code session-end"],
    });
    expect(CLAUDE_HOOKS).toHaveLength(10);
    expect(await claude.hooksInstalled(ws)).toBe(true);
    await claude.uninstallHooks(ws);
    expect(await claude.hooksInstalled(ws)).toBe(false);
  });
});

describe("fake agent", () => {
  const fake = getAgent("fake");
  let repo: string;
  let data: string;
  let path: string;
  beforeEach(async () => {
    repo = await makeRepo();
    data = await makeDataDir();
    path = worktreePath(data, "proj", "r1", "root");
    await createWorktree({ repo, path, branch: "rivet/r1/root", from: "main" });
  });
  afterEach(async () => {
    await removeWorktree(data, repo, path).catch(() => {});
    await waitForTrash();
    await removeRepo(repo);
    await removeRepo(data);
  });

  function run(prompt: object) {
    return fake.launchCommand({ sessionId: "r1-root", workspace: path, prompt: JSON.stringify(prompt) })
      .then(([cmd, ...args]) => spawnSync(cmd!, args, { cwd: path, encoding: "utf8" }));
  }

  it("really writes and commits files in its worktree", async () => {
    const result = await run({ files: { "src/a.ts": "export const a = 1;\n" }, commit: "add a" });
    expect(result.status).toBe(0);
    expect(await readFile(join(path, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect((await git(["log", "-1", "--format=%s"], path)).trim()).toBe("add a");
    expect((await git(["status", "--porcelain"], path)).trim()).toBe("");
  });

  it("exits with the requested code and can leave work uncommitted", async () => {
    const result = await run({ files: { "b.txt": "b\n" }, exitCode: 3 });
    expect(result.status).toBe(3);
    expect(existsSync(join(path, "b.txt"))).toBe(true);
    expect((await git(["status", "--porcelain"], path)).trim()).toBe("?? b.txt");
  });

  it("reports each action on stdout", async () => {
    const result = await run({ files: { "a.txt": "a\n" }, commit: "add a" });
    expect(result.stdout.split(/\r?\n/).filter(Boolean)).toEqual(["wrote a.txt", "committed"]);
  });

  it("writes its RIVET_* environment to env.json when asked", async () => {
    const [cmd, ...args] = await fake.launchCommand({ sessionId: "r1-root", workspace: path, prompt: JSON.stringify({ dumpEnv: true }) });
    const result = spawnSync(cmd!, args, {
      cwd: path, encoding: "utf8", env: { ...process.env, RIVET_SESSION_ID: "r1-root", OTHER: "x" },
    });
    expect(result.status).toBe(0);
    const env = JSON.parse(await readFile(join(path, "env.json"), "utf8"));
    expect(env.RIVET_SESSION_ID).toBe("r1-root");
    expect(env.OTHER).toBeUndefined();
  });

  it("listens on stdin until /exit when asked", async () => {
    const [cmd, ...args] = await fake.launchCommand({ sessionId: "r1-root", workspace: path, prompt: JSON.stringify({ listen: true, exitCode: 4 }) });
    const result = spawnSync(cmd!, args, { cwd: path, encoding: "utf8", input: "hello\nsecond line\n/exit\nignored\n" });
    expect(result.status).toBe(4);
    expect(await readFile(join(path, "inbox.txt"), "utf8")).toBe("hello\nsecond line\n");
    expect(result.stdout).toContain("got hello");
  });

  it("stays alive for stayFor ms", async () => {
    const started = Date.now();
    await run({ stayFor: 300 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("cannot be resumed and has no hooks", async () => {
    expect(await fake.restoreCommand({ sessionId: "r1-root", workspace: path })).toBeNull();
    await fake.installHooks(path);
    expect(await fake.hooksInstalled(path)).toBe(false);
  });
});

describe("headless launches", () => {
  it("claude runs in print mode and then takes no typed input; the fake always listens", async () => {
    const claude = getAgent("claude");
    expect(await claude.launchCommand({ sessionId: "r1-root.1", workspace: ".", prompt: "go", headless: true, permission: "accept-edits", model: "haiku", allowedTools: ["Bash(rivet:*)"] }))
      .toEqual(["claude", "--session-id", "cce53ecb-99f4-55ff-a3cb-693ccbf24d77", "-p", "--model", "haiku", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(rivet:*)", "--", "go"]);
    expect(claude.acceptsInput({ headless: true })).toBe(false);
    expect(claude.acceptsInput({ headless: false })).toBe(true);
    expect(getAgent("fake").acceptsInput({ headless: true })).toBe(true);
  });
});

describe("interactive claude", () => {
  it("keeps the browser integration off", async () => {
    const argv = await getAgent("claude").launchCommand({ sessionId: "r1-root.1", workspace: ".", prompt: "go", headless: false });
    expect(argv).toContain("--no-chrome");
    expect(argv).not.toContain("-p");
  });
});
