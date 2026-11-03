import type { Agent } from "./agent.js";

// Delta runs only as a chat (its own JSON-lines protocol), so it has no terminal command.
export function deltaAgent(binary: string): Agent {
  const none = async (): Promise<never> => { throw new Error("delta runs only as a chat session"); };
  return {
    name: "delta",
    binary,
    signals: false,
    promptVia: "argv",
    acceptsInput: () => false,
    launchCommand: none,
    restoreCommand: none,
    installHooks: async () => {},
    uninstallHooks: async () => {},
    hooksInstalled: async () => false,
  };
}
