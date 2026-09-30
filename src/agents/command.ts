import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

// Rivet's own permission levels; each agent adapter maps them to its CLI's flags.
export const PERMISSIONS = ["default", "accept-edits", "auto", "bypass-permissions"] as const;
export type Permission = (typeof PERMISSIONS)[number];

// How the first prompt reaches the agent: as a command-line argument, or typed in once it is up.
export type PromptVia = "argv" | "after-start";

export type ClaudeOptions = {
  binary: string;
  model?: string;
  effort?: string;
  permission?: Permission;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  systemPromptFile?: string;
  extraArgs?: string[];
  prompt?: string;
};

export type ClaudeStart = ClaudeOptions & { sessionId?: string; nativeSessionId?: string };
export type ClaudeResume = ClaudeOptions & { sessionId: string; capturedId?: string };

// Fixed namespace for Rivet's name-based Claude session ids. Never change it:
// existing sessions could no longer be resumed.
const RIVET_NAMESPACE = "52dafd3b-df71-4e2b-a176-0fd918b1bfb7";

// Name-based UUID (RFC 4122 version 5): same name in, same id out.
function nameUuid(namespace: string, name: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = 0x50 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  return dashed(bytes.toString("hex"));
}

function dashed(hex: string): string {
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

// A Rivet session always maps to the same Claude conversation, so it can be resumed
// even when no hook ever reported Claude's own id.
export function claudeSessionId(sessionId: string): string {
  return nameUuid(RIVET_NAMESPACE, sessionId);
}

// Claude wants a canonical UUID. Accepts braces, a urn:uuid: prefix or no dashes.
function canonicalUuid(value: string): string | null {
  const hex = value.trim().replace(/^urn:uuid:/i, "").replace(/^\{(.*)\}$/, "$1");
  const plain = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(hex) ? hex.replace(/-/g, "") : hex;
  return /^[0-9a-f]{32}$/i.test(plain) ? dashed(plain.toLowerCase()) : null;
}

export function normalizePermission(value: string | undefined): Permission {
  return PERMISSIONS.find((p) => p === value) ?? "default";
}

const CLAUDE_MODES: Record<Permission, string | null> = {
  default: null,
  "accept-edits": "acceptEdits",
  auto: "auto",
  "bypass-permissions": "bypassPermissions",
};

export function claudePermissionArgs(permission: Permission): string[] {
  const mode = CLAUDE_MODES[normalizePermission(permission)];
  return mode ? ["--permission-mode", mode] : [];
}

// The id to resume: the one a hook captured from Claude, else the derived one.
export function resumeId(sessionId: string, capturedId?: string): string | null {
  const captured = capturedId?.trim();
  if (captured) return captured;
  return sessionId.trim() ? claudeSessionId(sessionId) : null;
}

// Checked up front so a bad path fails here, not inside a half-started agent.
async function readableFile(file: string): Promise<void> {
  const info = await stat(file).catch((e: Error) => {
    throw new Error(`claude-code: system prompt file: ${e.message}`);
  });
  if (!info.isFile()) throw new Error(`claude-code: system prompt file "${file}" is not a regular file`);
  await open(file, "r").then(
    (handle) => handle.close(),
    (e: Error) => {
      throw new Error(`claude-code: system prompt file: ${e.message}`);
    },
  );
}

async function claudeCommand(o: ClaudeOptions, conversation: string[]): Promise<string[]> {
  if (!o.binary.trim()) throw new Error("claude-code: binary is required");
  const args = [o.binary, ...conversation];
  const flag = (name: string, value?: string) => {
    if (value?.trim()) args.push(name, value.trim());
  };
  flag("--model", o.model);
  flag("--effort", o.effort);
  args.push(...claudePermissionArgs(o.permission ?? "default"));
  flag("--allowedTools", o.allowedTools?.join(","));
  flag("--disallowedTools", o.disallowedTools?.join(","));
  if (o.systemPromptFile) {
    await readableFile(o.systemPromptFile);
    args.push("--append-system-prompt-file", o.systemPromptFile);
  } else if (o.systemPrompt) {
    args.push("--append-system-prompt", o.systemPrompt);
  }
  args.push(...(o.extraArgs ?? []));
  // "--" keeps a prompt that starts with "-" from being read as a flag.
  if (o.prompt) args.push("--", o.prompt);
  return args;
}

export async function claudeStartCommand(o: ClaudeStart): Promise<string[]> {
  let id: string | null = null;
  if (o.nativeSessionId) {
    id = canonicalUuid(o.nativeSessionId);
    if (id === null) throw new Error(`claude-code: invalid native session id: ${o.nativeSessionId.trim()}`);
  } else if (o.sessionId) {
    id = claudeSessionId(o.sessionId);
  }
  return claudeCommand(o, id ? ["--session-id", id] : []);
}

export async function claudeResumeCommand(o: ClaudeResume): Promise<string[] | null> {
  if (!o.binary.trim()) throw new Error("claude-code: binary is required");
  const id = resumeId(o.sessionId, o.capturedId);
  return id === null ? null : claudeCommand(o, ["--resume", id]);
}
