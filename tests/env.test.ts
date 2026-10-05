import { describe, expect, it } from "vitest";
import { agentEnv, sessionIdOf } from "../src/runtime/env.js";

describe("agentEnv", () => {
  it("tells the agent who it is and how to reach the daemon", () => {
    expect(agentEnv({
      runId: "r1", nodeId: "root.1", project: "proj", dataDir: "/d", runFile: "/d/running.json", launchId: "abc",
    })).toMatchObject({
      RIVET_SESSION_ID: "r1-root.1",
      RIVET_PROJECT_ID: "proj",
      RIVET_DATA_DIR: "/d",
      RIVET_RUN_FILE: "/d/running.json",
      RIVET_LAUNCH_ID: "abc",
    });
  });

  it("builds session ids from run and node", () => {
    expect(sessionIdOf("r1", "root.1")).toBe("r1-root.1");
    expect(() => sessionIdOf("r-1", "root")).toThrow(/invalid run id for a session/);
  });
});

describe("agent PATH", () => {
  it("puts Rivet's own bin folder first so hooks find this rivet", async () => {
    const { rivetBinDir } = await import("../src/runtime/env.js");
    const env = agentEnv({ runId: "r1", nodeId: "root", project: "p", dataDir: "/d", runFile: "/f", launchId: "x" });
    const { delimiter } = await import("node:path");
    expect(env.PATH!.split(delimiter)[0]).toBe(rivetBinDir());
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${rivetBinDir()}/rivet`)).toBe(true);
  });
});
