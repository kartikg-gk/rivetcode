import { readFileSync } from "node:fs";

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8")) as { name: string; base64: string };
  const bytes = Buffer.from(input.base64, "base64");
  let text: string;
  let truncated = false;
  if (/\.pdf$/i.test(input.name)) {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: bytes, isEvalSupported: false, useWorkerFetch: false });
    try {
      const result = await parser.getText({ first: 20 });
      text = result.text;
      truncated = result.total > 20;
    } finally { await parser.destroy(); }
  } else if (/\.docx$/i.test(input.name)) {
    const { extractRawText } = await import("mammoth");
    text = (await extractRawText({ buffer: bytes })).value;
  } else {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("binary document");
  }
  process.stdout.write(JSON.stringify({ text: text.slice(0, 32000), truncated: truncated || text.length > 32000 }));
}

main().catch(() => { process.exitCode = 1; });
