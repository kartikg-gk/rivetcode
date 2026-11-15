import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { assertId } from "../paths.js";

// The folder holding the rivet command for this very installation (works from src and dist).
export function rivetBinDir(): string {
  return fileURLToPath(new URL("../../bin", import.meta.url));
}

function currentPath(): string {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH");
  return key ? process.env[key] ?? "" : "";
}

// Set by a Claude Code session for the commands it runs. An agent that inherits them
// (Rivet started from inside Claude Code) counts itself as that session's child and keeps
// no transcript, so its conversation could never be resumed.
const PARENT_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"];

// The daemon's own environment, minus what describes the session that started Rivet.
export function inheritedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    if (PARENT_SESSION_VARS.includes(key.toUpperCase())) delete out[key];
  }
  return out;
}

// A session is one node of one run. Run ids never contain "-", so the first "-" splits them.
export function sessionIdOf(runId: string, nodeId: string): string {
  assertId("run", runId);
  assertId("node", nodeId);
  if (runId.includes("-")) throw new Error(`invalid run id for a session: "${runId}"`);
  return `${runId}-${nodeId}`;
}

// What an agent process needs to know about itself and to reach the daemon from its hooks.
export function agentEnv(o: {
  runId: string;
  nodeId: string;
  project: string;
  dataDir: string;
  runFile: string;
  launchId: string;
}): Record<string, string> {
  return {
    RIVET_SESSION_ID: sessionIdOf(o.runId, o.nodeId),
    RIVET_PROJECT_ID: o.project,
    RIVET_DATA_DIR: o.dataDir,
    RIVET_RUN_FILE: o.runFile,
    RIVET_LAUNCH_ID: o.launchId,
    // Agent hooks call "rivet ..."; this makes them reach the daemon that started them,
    // even when another rivet (or none) is on the user's PATH.
    PATH: [rivetBinDir(), currentPath()].filter(Boolean).join(delimiter),
    // The Node running this daemon: the rivet command an agent types runs on it too, so it works
    // with no Node (or an older one) on PATH, as after the one-line install.
    RIVET_NODE: process.execPath,
  };
}
