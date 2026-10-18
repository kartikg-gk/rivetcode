import { join } from "node:path";
import type { Agent } from "./agent.js";
import { normalizePermission, type Permission } from "./command.js";
import { rivetBinDir } from "../runtime/env.js";

// Values for Codex's -c key=value overrides are TOML.
export function tomlString(value: string): string {
  const control = /[\u0000-\u001f\u007f]/.test(value);
  if (!control && !value.includes("'")) return `'${value}'`;
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function basicString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const BASE_ARGS = [
  "-c", "check_for_update_on_startup=false",
  "-c", "notice.hide_rate_limit_model_nudge=true",
  // Rivet's hooks arrive as launch flags, which carry no stored trust.
  "--dangerously-bypass-hook-trust",
];

// Headless (codex exec) has nobody to approve anything: edits stay in a writable sandbox.
export function codexPermissionArgs(permission: Permission, headless: boolean): string[] {
  const p = normalizePermission(permission);
  if (p === "accept-edits" || p === "auto") {
    if (headless) return ["--sandbox", "workspace-write"];
    return p === "auto"
      ? ["--ask-for-approval", "on-request", "-c", 'approvals_reviewer="auto_review"']
      : ["--ask-for-approval", "on-request"];
  }
  return ["--dangerously-bypass-approvals-and-sandbox"];
}

// The worktree is trusted for this launch only; nothing is written to the user's config.
function trustArgs(workspace: string): string[] {
  return workspace.trim() ? ["-c", `projects={${tomlString(workspace)}={trust_level="trusted"}}`] : [];
}

const HOOKS: [event: string, action: string][] = [
  ["SessionStart", "session-start"],
  ["UserPromptSubmit", "user-prompt-submit"],
  ["PermissionRequest", "permission-request"],
  ["Stop", "stop"],
];

// Codex never reads hook files from a linked worktree, so the hooks ride the launch
// command. They call this rivet by absolute path: hook shells may not keep our PATH.
export function codexHookFlags(rivet: string, platform: NodeJS.Platform = process.platform): string[] {
  const quoted = `'${rivet.replace(/'/g, "''")}'`;
  // Codex runs hooks through PowerShell on Windows, where a quoted path needs "&".
  const call = platform === "win32" ? `& ${quoted}` : quoted;
  return HOOKS.flatMap(([event, action]) => [
    "-c", `hooks.${event}=[{hooks=[{type="command",command=${basicString(`${call} hooks codex ${action}`)},timeout=5}]}]`,
  ]);
}

export type CodexOptions = {
  binary: string;
  workspace: string;
  permission?: Permission;
  model?: string;
  systemPrompt?: string;
  prompt?: string;
  headless?: boolean;
  hookFlags: string[];
};

function common(o: CodexOptions): string[] {
  const args = [...trustArgs(o.workspace)];
  if (o.model?.trim()) args.push("--model", o.model.trim());
  if (o.systemPrompt) args.push("-c", `developer_instructions=${tomlString(o.systemPrompt)}`);
  return args;
}

export function codexStartCommand(o: CodexOptions): string[] {
  const args = [o.binary, ...(o.headless ? ["exec"] : []), ...BASE_ARGS,
    ...codexPermissionArgs(o.permission ?? "default", !!o.headless), ...o.hookFlags, ...common(o)];
  if (o.prompt) args.push("--", o.prompt);
  return args;
}

// Codex ids are its own; only one a hook captured can be resumed.
export function codexResumeCommand(o: CodexOptions & { capturedId?: string }): string[] | null {
  const id = o.capturedId?.trim();
  if (!id) return null;
  // Headless resume (codex exec resume) takes no --sandbox flag; the same mode goes in as config.
  const permission = codexPermissionArgs(o.permission ?? "default", !!o.headless)
    .flatMap((a, i, all) => (a === "--sandbox" ? ["-c", `sandbox_mode=${basicString(all[i + 1]!)}`] : all[i - 1] === "--sandbox" ? [] : [a]));
  const args = [o.binary, ...(o.headless ? ["exec", "resume"] : ["resume"]), ...BASE_ARGS, ...permission, ...o.hookFlags, ...common(o), id];
  if (o.prompt) args.push("--", o.prompt);
  return args;
}

function rivetExecutable(): string {
  return join(rivetBinDir(), process.platform === "win32" ? "rivet.cmd" : "rivet");
}

export function codexAgent(binary: string): Agent {
  const hookFlags = () => codexHookFlags(rivetExecutable());
  return {
    name: "codex",
    signals: true,
    promptVia: "argv",
    acceptsInput: ({ headless }) => !headless,
    launchCommand: async (cfg) => codexStartCommand({
      binary, workspace: cfg.workspace, hookFlags: hookFlags(),
      ...(cfg.permission ? { permission: cfg.permission } : {}),
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.systemPrompt ? { systemPrompt: cfg.systemPrompt } : {}),
      ...(cfg.prompt ? { prompt: cfg.prompt } : {}),
      ...(cfg.headless ? { headless: true } : {}),
    }),
    restoreCommand: async (cfg) => codexResumeCommand({
      binary, workspace: cfg.workspace, hookFlags: hookFlags(),
      ...(cfg.capturedId ? { capturedId: cfg.capturedId } : {}),
      ...(cfg.permission ? { permission: cfg.permission } : {}),
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.prompt ? { prompt: cfg.prompt } : {}),
      ...(cfg.headless ? { headless: true } : {}),
    }),
    installHooks: async () => {},
    uninstallHooks: async () => {},
    hooksInstalled: async () => false,
  };
}
