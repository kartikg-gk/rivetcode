import type { Cue } from "../store.js";

// Limits on a cue, in bytes as stored.
export const CUE_NAME_LIMIT = 64;
export const CUE_COMMAND_LIMIT = 4096;
export const CUE_PROMPT_LIMIT = 16_384;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// A valid cue or an error saying what is wrong. Names are one word so the CLI can take
// them as they are.
export function checkCue(project: string, name: string, type: unknown, text: unknown): Cue {
  const n = name.trim();
  if (!n || bytes(n) > CUE_NAME_LIMIT || !/^[\w.-]+$/.test(n)) {
    throw new Error(`a cue name is one word of letters, digits, ".", "-" or "_", at most ${CUE_NAME_LIMIT} bytes`);
  }
  if (type !== "agent" && type !== "command") throw new Error("a cue is an agent prompt or a command");
  if (typeof text !== "string" || !text.trim()) throw new Error(type === "agent" ? "an agent cue needs a prompt" : "a command cue needs a command");
  const limit = type === "agent" ? CUE_PROMPT_LIMIT : CUE_COMMAND_LIMIT;
  if (bytes(text) > limit) throw new Error(`the ${type === "agent" ? "prompt" : "command"} is longer than ${limit} bytes`);
  return { project, name: n, type, text: text.trim(), updatedAt: new Date().toISOString() };
}
