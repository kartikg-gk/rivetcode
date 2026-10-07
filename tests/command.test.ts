import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudePermissionArgs,
  claudeResumeCommand,
  claudeSessionId,
  claudeStartCommand,
  normalizePermission,
  resumeId,
} from "../src/agents/command.js";
import { makeDataDir, removeRepo } from "./helpers.js";

// Python: uuid.uuid5(uuid.UUID("52dafd3b-df71-4e2b-a176-0fd918b1bfb7"), "r1-root.1")
const DERIVED = "cce53ecb-99f4-55ff-a3cb-693ccbf24d77";

describe("claudeSessionId", () => {
  it("maps a session id to a fixed name-based UUID", () => {
    expect(claudeSessionId("r1-root.1")).toBe(DERIVED);
    expect(claudeSessionId("r1-root.2")).not.toBe(DERIVED);
  });
});

describe("permissions", () => {
  it("maps each level to Claude's permission mode", () => {
    expect(claudePermissionArgs("default")).toEqual([]);
    expect(claudePermissionArgs("accept-edits")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(claudePermissionArgs("auto")).toEqual(["--permission-mode", "auto"]);
    expect(claudePermissionArgs("bypass-permissions")).toEqual(["--permission-mode", "bypassPermissions"]);
  });

  it("treats unknown values as default", () => {
    expect(normalizePermission("yolo")).toBe("default");
    expect(normalizePermission(undefined)).toBe("default");
    expect(claudePermissionArgs("yolo" as never)).toEqual([]);
  });
});

describe("claudeStartCommand", () => {
  it("builds the minimal command", async () => {
    expect(await claudeStartCommand({ binary: "claude" })).toEqual(["claude"]);
  });

  it("puts the session first and the prompt last", async () => {
    const cmd = await claudeStartCommand({
      binary: "claude",
      sessionId: "r1-root.1",
      permission: "auto",
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      extraArgs: ["--verbose"],
      model: " opus ",
      effort: "high",
      systemPrompt: "stay in scope",
      prompt: "--do the task",
    });
    expect(cmd).toEqual([
      "claude",
      "--session-id", DERIVED,
      "--model", "opus",
      "--effort", "high",
      "--permission-mode", "auto",
      "--allowedTools", "Read,Grep",
      "--disallowedTools", "Bash",
      "--append-system-prompt", "stay in scope",
      "--verbose",
      "--", "--do the task",
    ]);
  });

  it("prefers a native session id and requires it to be a UUID", async () => {
    const native = "6F9619FF-8B86-D011-B42D-00C04FC964FF";
    expect(await claudeStartCommand({ binary: "claude", sessionId: "r1-root", nativeSessionId: native }))
      .toEqual(["claude", "--session-id", "6f9619ff-8b86-d011-b42d-00c04fc964ff"]);
    await expect(claudeStartCommand({ binary: "claude", nativeSessionId: "nope" }))
      .rejects.toThrow(/invalid native session id/);
  });

  it.each([
    "{6f9619ff-8b86-d011-b42d-00c04fc964ff}",
    "urn:uuid:6F9619FF-8B86-D011-B42D-00C04FC964FF",
    "6f9619ff8b86d011b42d00c04fc964ff",
  ])("accepts the native id form %s and writes it canonically", async (native) => {
    expect(await claudeStartCommand({ binary: "claude", nativeSessionId: native }))
      .toEqual(["claude", "--session-id", "6f9619ff-8b86-d011-b42d-00c04fc964ff"]);
  });

  it("requires a binary", async () => {
    await expect(claudeStartCommand({ binary: "  " })).rejects.toThrow(/binary is required/);
  });

  describe("system prompt file", () => {
    let dir: string;
    beforeEach(async () => { dir = await makeDataDir(); });
    afterEach(async () => { await removeRepo(dir); });

    it("is passed as a file and wins over the inline prompt", async () => {
      const file = join(dir, "system.md");
      await writeFile(file, "rules");
      expect(await claudeStartCommand({ binary: "claude", systemPromptFile: file, systemPrompt: "ignored" }))
        .toEqual(["claude", "--append-system-prompt-file", file]);
    });

    it("must be a regular file", async () => {
      await mkdir(join(dir, "folder"));
      await expect(claudeStartCommand({ binary: "claude", systemPromptFile: join(dir, "folder") }))
        .rejects.toThrow(/is not a regular file/);
      await expect(claudeStartCommand({ binary: "claude", systemPromptFile: join(dir, "missing") }))
        .rejects.toThrow(/system prompt file/);
    });
  });
});

describe("resume", () => {
  it("uses the hook-captured id first, then the derived one", () => {
    expect(resumeId("r1-root", " abc ")).toBe("abc");
    expect(resumeId("r1-root.1")).toBe(DERIVED);
    expect(resumeId("")).toBeNull();
  });

  it("builds a resume command, prompt last", async () => {
    expect(await claudeResumeCommand({
      binary: "claude", sessionId: "r1-root.1", permission: "accept-edits", model: "sonnet", prompt: "continue",
    })).toEqual([
      "claude", "--resume", DERIVED, "--model", "sonnet", "--permission-mode", "acceptEdits", "--", "continue",
    ]);
  });

  it("returns null when nothing can be resumed", async () => {
    expect(await claudeResumeCommand({ binary: "claude", sessionId: "" })).toBeNull();
  });
});

describe("headless (print) mode", () => {
  it("adds -p after the session so the agent runs without a terminal", async () => {
    expect(await claudeStartCommand({ binary: "claude", sessionId: "r1-root.1", print: true, prompt: "go" }))
      .toEqual(["claude", "--session-id", DERIVED, "-p", "--", "go"]);
    expect(await claudeResumeCommand({ binary: "claude", sessionId: "r1-root.1", print: true }))
      .toEqual(["claude", "--resume", DERIVED, "-p"]);
  });
});
