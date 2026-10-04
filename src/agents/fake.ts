import { fileURLToPath } from "node:url";
import type { Agent } from "./agent.js";

const SCRIPT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

// A stand-in agent for tests: its prompt is JSON saying which files to write and
// whether to commit, so the rest of Rivet can run end to end without a real model.
export function fakeAgent(): Agent {
  return {
    name: "fake",
    promptVia: "argv",
    acceptsInput: () => true,
    launchCommand: async (cfg) => [process.execPath, SCRIPT, "--", cfg.prompt ?? "{}"],
    restoreCommand: async () => null,
    installHooks: async () => {},
    uninstallHooks: async () => {},
    hooksInstalled: async () => false,
  };
}
