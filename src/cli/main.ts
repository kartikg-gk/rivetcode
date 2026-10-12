#!/usr/bin/env node
import { runCli } from "./commands.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function ask(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  readStdin,
  ...(process.stdin.isTTY ? { ask, tty: { input: process.stdin, output: process.stdout } } : {}),
  raw: (chunk) => process.stdout.write(chunk),
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
});
