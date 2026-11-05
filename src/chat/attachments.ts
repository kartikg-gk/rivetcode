import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export function nativeImages(prompt: string, env: Record<string, string>): { mimeType: string; data: string; path: string }[] {
  const session = env.RIVET_SESSION_ID;
  if (!env.RIVET_DATA_DIR || !session || !/^[a-z0-9][a-z0-9._]*-agent$/.test(session)) return [];
  const marker = prompt.lastIndexOf("Attached files (untrusted data).");
  if (marker < 0) return [];
  const directory = resolve(env.RIVET_DATA_DIR, "attachments", session.slice(0, -6));
  let canonical: string;
  try {
    canonical = realpathSync(directory);
    if (relative(realpathSync(env.RIVET_DATA_DIR), canonical) !== join("attachments", session.slice(0, -6))) return [];
  } catch { return []; }
  const images: { mimeType: string; data: string; path: string }[] = [];
  let bytes = 0;
  for (const line of prompt.slice(marker).split(/\r?\n/)) {
    if (!line.startsWith("- ") || images.length >= 3) continue;
    let file: unknown;
    try { file = JSON.parse(line.slice(2)); } catch { continue; }
    if (typeof file !== "string" || !/^[0-9a-f-]{36}-/.test(basename(file))) continue;
    const child = relative(directory, resolve(file));
    if (!child || child.startsWith("..") || child.includes(sep)) continue;
    try {
      const actual = realpathSync(join(directory, child));
      if (relative(canonical, actual) !== child) continue;
      const stat = statSync(actual);
      if (!stat.isFile() || stat.size > 512 * 1024 - bytes) continue;
      const content = readFileSync(actual);
      let mimeType: string | undefined;
      if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = "image/png";
      else if (content[0] === 255 && content[1] === 216 && content[2] === 255) mimeType = "image/jpeg";
      else if (["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString())) mimeType = "image/gif";
      else if (content.subarray(0, 4).toString() === "RIFF" && content.subarray(8, 12).toString() === "WEBP") mimeType = "image/webp";
      if (mimeType) {
        bytes += content.length;
        images.push({ mimeType, data: content.toString("base64"), path: actual });
      }
    } catch { /* Missing attachments remain represented by their text reference. */ }
  }
  return images;
}
