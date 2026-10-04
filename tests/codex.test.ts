import { describe, expect, it } from "vitest";
import { getAgent } from "../src/agents/agent.js";
import { codexHookFlags, codexPermissionArgs, codexResumeCommand, codexStartCommand, tomlString } from "../src/agents/codex.js";
import { deriveActivity } from "../src/cli/activity.js";

const BASE = ["-c", "check_for_update_on_startup=false", "-c", "notice.hide_rate_limit_model_nudge=true", "--dangerously-bypass-hook-trust"];

describe("tomlString", () => {
  it("uses a literal string when it can, else an escaped basic string", () => {
    expect(tomlString("C:\\work tree\\a")).toBe("'C:\\work tree\\a'");
    expect(tomlString("it's")).toBe('"it\'s"');
    expect(tomlString('say "hi"\nnow')).toBe('"say \\"hi\\"\\u000Anow"');
  });
});

describe("codex permissions", () => {
  it("maps each level to approval flags", () => {
    expect(codexPermissionArgs("accept-edits", false)).toEqual(["--ask-for-approval", "on-request"]);
    expect(codexPermissionArgs("auto", false)).toEqual(["--ask-for-approval", "on-request", "-c", 'approvals_reviewer="auto_review"']);
    expect(codexPermissionArgs("default", false)).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(codexPermissionArgs("bypass-permissions", false)).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });

  it("cannot ask anyone when headless, so edits stay inside a writable sandbox", () => {
    expect(codexPermissionArgs("accept-edits", true)).toEqual(["--sandbox", "workspace-write"]);
    expect(codexPermissionArgs("auto", true)).toEqual(["--sandbox", "workspace-write"]);
    expect(codexPermissionArgs("bypass-permissions", true)).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });
});

describe("codex commands", () => {
  const hooks = codexHookFlags("/opt/rivet/bin/rivet", "linux");

  it("starts the TUI with trust, hooks, model, instructions and the prompt last", () => {
    expect(codexStartCommand({
      binary: "codex", workspace: "/w", permission: "accept-edits", model: "gpt-5", systemPrompt: "stay in scope", prompt: "go", hookFlags: hooks,
    })).toEqual([
      "codex", ...BASE, "--ask-for-approval", "on-request", ...hooks,
      "-c", "projects={'/w'={trust_level=\"trusted\"}}", "--model", "gpt-5",
      "-c", "developer_instructions='stay in scope'", "--", "go",
    ]);
  });

  it("runs codex exec when headless", () => {
    const cmd = codexStartCommand({ binary: "codex", workspace: "/w", permission: "accept-edits", prompt: "go", headless: true, hookFlags: [] });
    expect(cmd.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(cmd).toContain("workspace-write");
    expect(cmd.slice(-2)).toEqual(["--", "go"]);
  });

  it("resumes only with the id its hooks captured", () => {
    expect(codexResumeCommand({ binary: "codex", workspace: "/w", hookFlags: [] })).toBeNull();
    expect(codexResumeCommand({ binary: "codex", workspace: "/w", capturedId: "th-1", prompt: "continue", hookFlags: [] }))
      .toEqual(["codex", "resume", ...BASE, "--dangerously-bypass-approvals-and-sandbox", "-c", "projects={'/w'={trust_level=\"trusted\"}}", "th-1", "--", "continue"]);
  });

  it("delivers its hooks as per-launch config calling this rivet by absolute path", () => {
    expect(hooks).toEqual([
      "-c", 'hooks.SessionStart=[{hooks=[{type="command",command="\'/opt/rivet/bin/rivet\' hooks codex session-start",timeout=5}]}]',
      "-c", 'hooks.UserPromptSubmit=[{hooks=[{type="command",command="\'/opt/rivet/bin/rivet\' hooks codex user-prompt-submit",timeout=5}]}]',
      "-c", 'hooks.PermissionRequest=[{hooks=[{type="command",command="\'/opt/rivet/bin/rivet\' hooks codex permission-request",timeout=5}]}]',
      "-c", 'hooks.Stop=[{hooks=[{type="command",command="\'/opt/rivet/bin/rivet\' hooks codex stop",timeout=5}]}]',
    ]);
    // Windows runs hooks through PowerShell, which needs the call operator.
    expect(codexHookFlags("C:\\r\\bin\\rivet.cmd", "win32")[1]).toBe(
      'hooks.SessionStart=[{hooks=[{type="command",command="& \'C:\\\\r\\\\bin\\\\rivet.cmd\' hooks codex session-start",timeout=5}]}]',
    );
  });
});

describe("codex adapter", () => {
  it("is registered, writes no hook files and takes typed input only with a terminal", async () => {
    const codex = getAgent("codex", { binary: "codex" });
    expect(codex.name).toBe("codex");
    expect(codex.acceptsInput({ headless: true })).toBe(false);
    expect(codex.acceptsInput({ headless: false })).toBe(true);
    const argv = await codex.launchCommand({ sessionId: "r1-root.1", workspace: "/w", prompt: "go", headless: true });
    expect(argv[1]).toBe("exec");
    expect(argv.some((a) => a.startsWith("hooks.Stop="))).toBe(true);
    expect(await codex.hooksInstalled("/w")).toBe(false);
  });

  it("maps codex hook events to activity", () => {
    expect(deriveActivity("codex", "user-prompt-submit", {})).toBe("active");
    expect(deriveActivity("codex", "permission-request", {})).toBe("waiting_input");
    expect(deriveActivity("codex", "stop", {})).toBe("idle");
    expect(deriveActivity("codex", "session-start", {})).toBeNull();
  });
});
