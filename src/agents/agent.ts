import type { Permission, PromptVia } from "./command.js";
import { claudeAgent } from "./claude.js";
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
};

// capturedId: the agent's own session id, as reported by its hooks.
export type AgentRestore = Omit<AgentLaunch, "nativeSessionId"> & { capturedId?: string };

// An adapter only describes how to run an agent's own CLI; running it is the runtime's job.
export type Agent = {
  name: AgentName;
  promptVia: PromptVia;
  launchCommand(cfg: AgentLaunch): Promise<string[]>;
  restoreCommand(cfg: AgentRestore): Promise<string[] | null>;
  installHooks(workspace: string): Promise<void>;
  uninstallHooks(workspace: string): Promise<void>;
  hooksInstalled(workspace: string): Promise<boolean>;
};

export type AgentName = "claude" | "fake";

export function getAgent(name: AgentName, opts: { binary?: string } = {}): Agent {
  switch (name) {
    case "claude":
      return claudeAgent(opts.binary ?? "claude");
    case "fake":
      return fakeAgent();
    default:
      throw new Error(`unknown agent "${String(name)}"`);
  }
}
