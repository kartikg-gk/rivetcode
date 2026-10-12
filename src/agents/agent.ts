import type { Permission, PromptVia } from "./command.js";
import { claudeAgent } from "./claude.js";
import { codexAgent } from "./codex.js";
import { fakeAgent } from "./fake.js";

export type AgentLaunch = {
  sessionId: string;
  workspace: string;
  prompt?: string;
  nativeSessionId?: string;
  permission?: Permission;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  // No terminal: the agent must run to completion on its own.
  headless?: boolean;
};

// capturedId: the agent's own session id, as reported by its hooks.
export type AgentRestore = Omit<AgentLaunch, "nativeSessionId"> & { capturedId?: string };

// An adapter only describes how to run an agent's own CLI; running it is the runtime's job.
export type Agent = {
  name: AgentName;
  promptVia: PromptVia;
  // Whether text typed into its stdin reaches it (how sent messages are delivered).
  acceptsInput(o: { headless: boolean }): boolean;
  launchCommand(cfg: AgentLaunch): Promise<string[]>;
  restoreCommand(cfg: AgentRestore): Promise<string[] | null>;
  installHooks(workspace: string): Promise<void>;
  uninstallHooks(workspace: string): Promise<void>;
  hooksInstalled(workspace: string): Promise<boolean>;
  // Runs just before launch (e.g. marking the worktree trusted for an interactive agent).
  prepare?(o: { workspace: string; headless: boolean }): Promise<void>;
};

export type AgentName = "claude" | "codex" | "fake";

export function getAgent(name: AgentName, opts: { binary?: string; claudeConfig?: string } = {}): Agent {
  switch (name) {
    case "claude":
      return claudeAgent(opts.binary ?? "claude", opts.claudeConfig);
    case "codex":
      return codexAgent(opts.binary ?? "codex");
    case "fake":
      return fakeAgent();
    default:
      throw new Error(`unknown agent "${String(name)}"`);
  }
}
