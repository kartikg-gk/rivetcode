import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { claudeProjectsDir } from "./agents/claude.js";
import { conversationFile } from "./usage.js";
import { fromHook, type TimelineEntry } from "./timeline.js";

const MAX_TAIL = 2 * 1024 * 1024;

export function terminalRepliesFromTranscript(transcript: string, finalReply?: string): TimelineEntry[] {
  const replies = new Map<string, Set<string>>();
  let hasPrompt = false;
  for (const line of transcript.split(/\r?\n/)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || record.isSidechain === true || record.isMeta === true) continue;
    const content = record.message?.content;
    if (record.type === "user") {
      if (typeof content === "string" || (Array.isArray(content) && content.some(part => part?.type === "text") && !content.some(part => part?.type === "tool_result"))) {
        hasPrompt = true;
        replies.clear();
      }
      continue;
    }
    if (!hasPrompt || record.type !== "assistant" || !Array.isArray(content)) continue;
    const id = record.message?.id ?? record.uuid;
    if (typeof id !== "string") continue;
    const parts = replies.get(id) ?? new Set<string>();
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) parts.add(block.text);
    }
    if (parts.size) replies.set(id, parts);
  }
  const texts = [...replies.values()].map(parts => [...parts].join("\n"));
  if (finalReply?.trim() && !texts.at(-1)?.endsWith(finalReply)) texts.push(finalReply);
  return texts.slice(-50).flatMap(text => fromHook("claude-code", "stop", { last_assistant_message: text }));
}

export function claudeTerminalReplies(sessionId: string, finalReply?: string): TimelineEntry[] {
  if (!/^[a-z0-9-]{1,128}$/i.test(sessionId)) return [];
  try {
    const file = conversationFile("claude", sessionId);
    if (!file) return [];
    const canonical = realpathSync(file);
    const inside = relative(realpathSync(claudeProjectsDir()), canonical);
    if (isAbsolute(inside) || inside.startsWith(".." + sep) || inside.split(sep).length !== 2 || !inside.endsWith(sep + sessionId + ".jsonl")) return [];
    const fd = openSync(canonical, "r");
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) return [];
      const start = Math.max(0, stats.size - MAX_TAIL);
      const buffer = Buffer.alloc(stats.size - start);
      const size = readSync(fd, buffer, 0, buffer.length, start);
      const tail = buffer.toString("utf8", 0, size);
      return terminalRepliesFromTranscript(start ? tail.slice(tail.indexOf("\n") + 1) : tail, finalReply);
    } finally { closeSync(fd); }
  } catch { return []; }
}
