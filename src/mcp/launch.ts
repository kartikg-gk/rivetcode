import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Explicit session environment avoids relying on what a provider forwards to tools.
export function mcpLaunch(env: Record<string, string>) {
  const main = fileURLToPath(new URL("../cli/main.js", import.meta.url));
  return {
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", existsSync(main) ? main : fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url)), "mcp"],
    env: Object.fromEntries(Object.entries(env).filter(([k]) => ["RIVET_SESSION_ID", "RIVET_PROJECT_ID", "RIVET_DATA_DIR", "RIVET_RUN_FILE", "RIVET_LAUNCH_ID"].includes(k))),
  };
}
