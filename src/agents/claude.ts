import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "./agent.js";
import { claudeResumeCommand, claudeStartCommand } from "./command.js";
import { hooksManager, type HookSpec } from "./hooks.js";
import { claudeConfigPath, ensureClaudeTrust } from "./trust.js";

// Hooks run node on Rivet's CLI directly: Claude waits on PreToolUse and PostToolUse for
// every tool call, and going through the rivet.cmd shim adds a cmd.exe start each time.
function rivetLauncher(): string {
  const quote = (p: string) => `"${p.replace(/\\/g, "/")}"`;
  const main = fileURLToPath(new URL("../cli/main.js", import.meta.url));
  return `${quote(process.execPath)} --disable-warning=ExperimentalWarning ${quote(main)}`;
}

const PREFIX = `${rivetLauncher()} hooks claude-code `;

// Ours whichever way they were written: by this install, by another install path, or in
// the older "rivet hooks claude-code <event>" form, so re-installs replace them.
export function isRivetClaudeHook(command: string): boolean {
  return / hooks claude-code [a-z-]+$/.test(command) && (command.startsWith("rivet ") || command.includes("/cli/main.js\""));
}

// SessionStart also fires on resume, /clear, compaction and fork, not only on startup.
const SESSION_START_MATCHER = "startup|resume|clear|compact|fork";

export const CLAUDE_HOOKS: HookSpec[] = [
  { event: "SessionStart", matcher: SESSION_START_MATCHER, command: `${PREFIX}session-start` },
  { event: "UserPromptSubmit", command: `${PREFIX}user-prompt-submit` },
  { event: "PreToolUse", command: `${PREFIX}pre-tool-use` },
  { event: "PostToolUse", command: `${PREFIX}post-tool-use` },
  { event: "PostToolUseFailure", command: `${PREFIX}post-tool-use-failure` },
  { event: "PermissionRequest", command: `${PREFIX}permission-request` },
  { event: "Stop", command: `${PREFIX}stop` },
  { event: "Notification", command: `${PREFIX}notification` },
  { event: "SubagentStop", command: `${PREFIX}subagent-stop` },
  { event: "SessionEnd", command: `${PREFIX}session-end` },
];

// Workspace-local settings: Claude merges this file over the user's own settings.
const claudeHooks = hooksManager({
  label: "claude-code",
  prefix: PREFIX,
  isOurs: isRivetClaudeHook,
  timeout: 30,
  path: (workspace) => join(workspace, ".claude", "settings.local.json"),
  managed: CLAUDE_HOOKS,
});

export function claudeAgent(binary: string, configPath = claudeConfigPath()): Agent {
  return {
    // Only the interactive app asks about folder trust; print mode does not.
    prepare: async ({ workspace, headless }) => {
      if (!headless) await ensureClaudeTrust(configPath, workspace);
    },
    name: "claude",
    promptVia: "argv",
    // Print mode reads stdin only at start, so a headless claude takes no messages.
    acceptsInput: ({ headless }) => !headless,
    // An agent Rivet starts in a terminal must not stop at a browser question or drive the user's browser.
    launchCommand: ({ headless, ...cfg }) => claudeStartCommand({
      binary, ...cfg, ...(headless ? { print: true } : {}), ...(headless === false ? { noChrome: true } : {}),
    }),
    restoreCommand: ({ headless, ...cfg }) => claudeResumeCommand({ binary, ...cfg, ...(headless ? { print: true } : {}) }),
    installHooks: (workspace) => claudeHooks.install(workspace),
    uninstallHooks: (workspace) => claudeHooks.uninstall(workspace),
    hooksInstalled: (workspace) => claudeHooks.installed(workspace),
  };
}
