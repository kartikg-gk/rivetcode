import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export function extractDocument(input: unknown): Promise<{ text: string; truncated: boolean }> {
  if (!input || typeof input !== "object") return Promise.reject(new Error("provide a document"));
  const { name, base64 } = input as Record<string, unknown>;
  if (typeof name !== "string" || name.length > 160 || typeof base64 !== "string" || base64.length > 700000) return Promise.reject(new Error("invalid document"));
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > 512 * 1024 || bytes.toString("base64") !== base64) return Promise.reject(new Error("invalid document encoding or size"));
  if (!/\.(pdf|docx|txt|md|csv|json|log|ts|tsx|js|py|yaml|yml)$/i.test(name)) return Promise.reject(new Error("preview supports PDF, DOCX and UTF-8 text files"));
  const adjacent = fileURLToPath(new URL("./document-worker.js", import.meta.url));
  const worker = existsSync(adjacent) ? adjacent : fileURLToPath(new URL("../../dist/daemon/document-worker.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["--max-old-space-size=256", worker], {
      windowsHide: true, timeout: 45000, maxBuffer: 512 * 1024,
      env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}) },
    }, (error, stdout) => {
      if (error) { reject(new Error("Document preview failed. The file may be invalid, encrypted or too complex.")); return; }
      try { resolve(JSON.parse(stdout) as { text: string; truncated: boolean }); }
      catch { reject(new Error("Document preview returned invalid output")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ name, base64 }));
  });
}
