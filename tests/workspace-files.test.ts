import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, readTextFile, saveTextFile } from "../src/daemon/workspace.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function folder() { const root = await mkdtemp(join(tmpdir(), "rivet-files-")); roots.push(root); return root; }

describe("workspace files", () => {
  it("lists folders and edits text with optimistic concurrency", async () => {
    const root = await folder();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "one.txt"), "original");
    expect((await listFiles(root, "")).entries).toMatchObject([{ name: "src", kind: "directory" }]);
    const original = await readTextFile(root, "src/one.txt");
    const results = await Promise.allSettled([
      saveTextFile(root, "src/one.txt", "first", original.version),
      saveTextFile(root, "src/one.txt", "second", original.version),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await readFile(join(root, "src", "one.txt"), "utf8")).toBe(results[0]!.status === "fulfilled" ? "first" : "second");
    await saveTextFile(root, "new.txt", "created", null);
    await expect(saveTextFile(root, "new.txt", "overwritten", null)).rejects.toThrow("changed");
  });

  it("refuses traversal, Git metadata and symlink escapes", async () => {
    const root = await folder(); const outside = await folder();
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(readTextFile(root, "../secret.txt")).rejects.toThrow();
    await expect(readTextFile(root, ".git/config")).rejects.toThrow();
    await expect(readTextFile(root, "escape/secret.txt")).rejects.toThrow();
    await expect(saveTextFile(root, "escape/new.txt", "blocked", null)).rejects.toThrow();
    await mkdir(join(root,".git"));
    await symlink(join(root,".git"),join(root,"metadata"),process.platform === "win32" ? "junction" : "dir");
    await expect(saveTextFile(root,"metadata/config","blocked",null)).rejects.toThrow("Git metadata");
  });
});
