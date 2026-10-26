import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "./agent.js";
import { claudeResumeCommand, claudeSessionId, claudeStartCommand, resumeId } from "./command.js";
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

// Where Claude keeps its conversations: one folder per working directory under projects/.
export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects");
}

// Whether Claude already has a conversation with this id, in any folder.
function conversationExists(projectsDir: string, id: string): boolean {
  let folders: string[];
  try { folders = readdirSync(projectsDir); } catch { return false; }
  return folders.some((f) => existsSync(join(projectsDir, f, `${id}.jsonl`)));
}

// On Windows Claude runs shell commands through its PowerShell tool as well as Bash, and a
// Bash rule does not cover PowerShell: each command rule is given for both, or an agent
// that picks PowerShell stops at a permission question.
export function shellRules(rules: string[] | undefined, platform: string = process.platform): string[] | undefined {
  if (!rules || platform !== "win32") return rules;
  const out = [...rules];
  for (const rule of rules) {
    const command = /^Bash\((.*)\)$/.exec(rule)?.[1];
    if (command !== undefined && !out.includes(`PowerShell(${command})`)) out.push(`PowerShell(${command})`);
  }
  return out;
}

// Headless, Claude prints every message and tool call as JSON events (--verbose is required
// for stream-json in print mode); Rivet keeps them as the session's timeline.
const STREAM_ARGS = ["--output-format", "stream-json", "--verbose"];

export function claudeAgent(binary: string, configPath = claudeConfigPath(), projectsDir = claudeProjectsDir(), platform: string = process.platform): Agent {
  return {
    // Only the interactive app asks about folder trust; print mode does not.
    prepare: async ({ workspace, headless }) => {
      if (!headless) await ensureClaudeTrust(configPath, workspace);
    },
    name: "claude",
    signals: true,
    promptVia: "argv",
    // Print mode reads stdin only at start, so a headless claude takes no messages.
    acceptsInput: ({ headless }) => !headless,
    // An agent Rivet starts in a terminal must not stop at a browser question or drive the user's browser.
    // A fresh launch is a new conversation. The id derived from Rivet's session is used
    // once: a relaunch of the same session (a retry) would reuse it, and Claude refuses an
    // id it already has, so a new one is taken. Hooks report whichever id Claude runs with.
    launchCommand: ({ headless, ...cfg }) => {
      const taken = !cfg.nativeSessionId && !!cfg.sessionId && conversationExists(projectsDir, claudeSessionId(cfg.sessionId));
      const allowedTools = shellRules(cfg.allowedTools, platform);
      return claudeStartCommand({
        binary, ...cfg, ...(allowedTools ? { allowedTools } : {}), ...(taken ? { nativeSessionId: randomUUID() } : {}),
        ...(headless ? { print: true, extraArgs: STREAM_ARGS } : {}), ...(headless === false ? { noChrome: true } : {}),
      });
    },
    // Only a conversation Claude actually saved can be resumed; otherwise there is none.
    restoreCommand: async ({ headless, ...cfg }) => {
      const id = resumeId(cfg.sessionId, cfg.capturedId);
      if (id === null || !conversationExists(projectsDir, id)) return null;
      const allowedTools = shellRules(cfg.allowedTools, platform);
      return claudeResumeCommand({
        binary, ...cfg, ...(allowedTools ? { allowedTools } : {}),
        ...(headless ? { print: true, extraArgs: STREAM_ARGS } : {}), ...(headless === false ? { noChrome: true } : {}),
      });
    },
    installHooks: (workspace) => claudeHooks.install(workspace),
    uninstallHooks: (workspace) => claudeHooks.uninstall(workspace),
    hooksInstalled: (workspace) => claudeHooks.installed(workspace),
  };
}
