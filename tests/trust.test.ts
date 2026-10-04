import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureClaudeTrust } from "../src/agents/trust.js";
import { makeDataDir, removeRepo } from "./helpers.js";

let dir: string;
let config: string;
beforeEach(async () => { dir = await makeDataDir(); config = join(dir, ".claude.json"); });
afterEach(async () => { await removeRepo(dir); });

const read = async () => JSON.parse(await readFile(config, "utf8"));

describe("ensureClaudeTrust", () => {
  it("adds only the trust flag and keeps everything else", async () => {
    await writeFile(config, JSON.stringify({ oauthAccount: { id: 1 }, projects: { "/other": { x: 1 }, "/w": { allowedTools: ["a"] } } }));
    expect(await ensureClaudeTrust(config, "/w", "linux")).toBe(true);
    expect(await read()).toEqual({ oauthAccount: { id: 1 }, projects: { "/other": { x: 1 }, "/w": { allowedTools: ["a"], hasTrustDialogAccepted: true } } });
  });

  it("writes nothing when already trusted", async () => {
    await writeFile(config, JSON.stringify({ projects: { "/w": { hasTrustDialogAccepted: true } } }, null, 1));
    const before = await readFile(config, "utf8");
    expect(await ensureClaudeTrust(config, "/w", "linux")).toBe(false);
    expect(await readFile(config, "utf8")).toBe(before);
  });

  it("uses forward slashes for Windows paths and creates a missing file", async () => {
    await ensureClaudeTrust(config, "C:\\data\\worktrees\\p\\r1-root.1", "win32");
    expect(await read()).toEqual({ projects: { "C:/data/worktrees/p/r1-root.1": { hasTrustDialogAccepted: true } } });
  });

  it("refuses an empty or corrupt config instead of replacing it", async () => {
    await writeFile(config, "  ");
    await expect(ensureClaudeTrust(config, "/w", "linux")).rejects.toThrow(/empty; refusing/);
    await writeFile(config, "{broken");
    await expect(ensureClaudeTrust(config, "/w", "linux")).rejects.toThrow(/parse/);
    expect(await readFile(config, "utf8")).toBe("{broken");
  });

  it("keeps every entry when many workspaces are trusted at once", async () => {
    await writeFile(config, "{}");
    await Promise.all(Array.from({ length: 8 }, (_, i) => ensureClaudeTrust(config, `/w${i}`, "linux")));
    expect(Object.keys((await read()).projects).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `/w${i}`));
  });
});

describe("claude adapter prepare", () => {
  it("trusts the worktree only for interactive launches", async () => {
    const { getAgent } = await import("../src/agents/agent.js");
    const claude = getAgent("claude", { claudeConfig: config });
    await claude.prepare!({ workspace: "/w", headless: true });
    await expect(readFile(config, "utf8")).rejects.toThrow();
    await claude.prepare!({ workspace: "/w", headless: false });
    expect((await read()).projects["/w"]).toEqual({ hasTrustDialogAccepted: true });
  });
});
