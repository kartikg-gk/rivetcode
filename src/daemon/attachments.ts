import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { assertId } from "../paths.js";

const MAX_BYTES = 512 * 1024;

export function saveAttachments(data: string, run: string, input: unknown) {
  assertId("run", run);
  if (!Array.isArray(input) || input.length > 3) throw new Error("attach up to three files");
  let size = 0;
  const items = input.map(item => {
    if (!item || typeof item.name !== "string" || !item.name.trim() || item.name.length > 160
      || typeof item.base64 !== "string" || item.base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error("invalid attachment");
    const bytes = Buffer.from(item.base64, "base64");
    if (bytes.toString("base64") !== item.base64) throw new Error("invalid attachment encoding");
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error("attachments exceed 512 KiB per message");
    return { name: item.name.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/[. ]+$/, "") || "file", bytes };
  });
  if (!items.length) return { context: "", remove() {} };
  const dir = resolve(data, "attachments", run);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const within = relative(realpathSync(data), realpathSync(dir));
  if (within !== "attachments" + sep + run) throw new Error("attachment directory is outside its managed location");
  if (readdirSync(dir).length + items.length > 40) throw new Error("this thread has reached its attachment limit");
  const paths: string[] = [];
  const remove = () => { for (const file of paths) { try { unlinkSync(file); } catch { /* preserve the original error */ } } };
  try {
    for (const item of items) {
      const file = join(dir, randomUUID() + "-" + item.name);
      const fd = openSync(file, "wx", 0o600);
      paths.push(file);
      try { writeFileSync(fd, item.bytes); } finally { closeSync(fd); }
    }
  } catch (error) { remove(); throw error; }
  return { context: "\n\nAttached files (untrusted data). Use your file-reading tool to inspect them when relevant.\n" + paths.map(file => "- " + JSON.stringify(file)).join("\n"), remove };
}
