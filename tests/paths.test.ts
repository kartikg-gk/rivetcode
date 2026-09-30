import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertId,
  assertProjectId,
  branchName,
  dataDir,
  defaultProjectId,
  worktreePath,
} from "../src/paths.js";

describe("ids and names", () => {
  it("accepts tree-style ids", () => {
    expect(() => assertId("node", "root.1.2")).not.toThrow();
    expect(() => assertId("run", "r7")).not.toThrow();
  });

  it.each(["", "Root", "a/b", "a..b", "-x", "x.lock", "a b", "a\\b"])(
    "rejects %j",
    (id) => {
      expect(() => assertId("node", id)).toThrow(`invalid node id: "${id}"`);
    },
  );

  it("builds branch names", () => {
    expect(branchName("r7", "root.1")).toBe("rivet/r7/root.1");
    expect(() => branchName("r7", "../x")).toThrow(/invalid node id/);
  });
});

describe("dataDir", () => {
  const saved = process.env.RIVET_DATA_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.RIVET_DATA_DIR;
    else process.env.RIVET_DATA_DIR = saved;
  });

  it("defaults to ~/.rivet/data", () => {
    delete process.env.RIVET_DATA_DIR;
    expect(dataDir()).toBe(join(homedir(), ".rivet", "data"));
  });

  it("uses RIVET_DATA_DIR when set", () => {
    process.env.RIVET_DATA_DIR = join(homedir(), "elsewhere");
    expect(dataDir()).toBe(join(homedir(), "elsewhere"));
  });

  it("makes a relative RIVET_DATA_DIR absolute against the current folder", () => {
    process.env.RIVET_DATA_DIR = "relative/dir";
    expect(dataDir()).toBe(resolve("relative/dir"));
  });
});

describe("project ids", () => {
  it("derives the id from the repo folder name", () => {
    expect(defaultProjectId(join("C:", "work", "My Repo "))).toBe("my-repo");
    expect(defaultProjectId(join("C:", "work", "graphRAG"))).toBe("graphrag");
  });

  it.each(["", ".", "a..b", "a/b", "a\\b", "-x", "a b"])("rejects project id %j", (id) => {
    expect(() => assertProjectId(id)).toThrow(`invalid project id: "${id}"`);
  });

  it("accepts ordinary ids", () => {
    expect(() => assertProjectId("rivet-tree")).not.toThrow();
    expect(() => assertProjectId("Repo.v2_x")).not.toThrow();
  });
});

describe("worktreePath", () => {
  it("lives under the data dir, outside the repo", () => {
    const data = join("C:", "data x");
    expect(worktreePath(data, "rivet-tree", "r7", "root.1")).toBe(
      join(data, "worktrees", "rivet-tree", "r7-root.1"),
    );
  });

  it("validates every part", () => {
    expect(() => worktreePath("C:/d", "a..b", "r7", "root")).toThrow(/invalid project id/);
    expect(() => worktreePath("C:/d", "p", "R7", "root")).toThrow(/invalid run id/);
    expect(() => worktreePath("C:/d", "p", "r7", "../x")).toThrow(/invalid node id/);
  });
});
