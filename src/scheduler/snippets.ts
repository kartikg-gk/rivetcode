import type { Snippet } from "../store.js";

// Limits on a snippet, in bytes as stored.
export const SNIPPET_NAME_LIMIT = 64;
export const SNIPPET_COMMAND_LIMIT = 4096;
export const SNIPPET_PROMPT_LIMIT = 16_384;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// A valid snippet or an error saying what is wrong. Names are one word so the CLI can take
// them as they are.
export function checkSnippet(project: string, name: string, type: unknown, text: unknown): Snippet {
  const n = name.trim();
  if (!n || bytes(n) > SNIPPET_NAME_LIMIT || !/^[\w.-]+$/.test(n)) {
    throw new Error(`a snippet name is one word of letters, digits, ".", "-" or "_", at most ${SNIPPET_NAME_LIMIT} bytes`);
  }
  if (type !== "agent" && type !== "command") throw new Error("a snippet is an agent prompt or a command");
  if (typeof text !== "string" || !text.trim()) throw new Error(type === "agent" ? "an agent snippet needs a prompt" : "a command snippet needs a command");
  const limit = type === "agent" ? SNIPPET_PROMPT_LIMIT : SNIPPET_COMMAND_LIMIT;
  if (bytes(text) > limit) throw new Error(`the ${type === "agent" ? "prompt" : "command"} is longer than ${limit} bytes`);
  return { project, name: n, type, text: text.trim(), updatedAt: new Date().toISOString() };
}
