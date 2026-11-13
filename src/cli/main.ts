#!/usr/bin/env node
// Install before loading commands: their imports may initialize node:sqlite.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const kind = typeof args[0] === "string" ? args[0]
    : typeof args[0] === "object" && args[0] !== null ? (args[0] as { type?: string }).type
    : warning instanceof Error ? warning.name : undefined;
  const message = typeof warning === "string" ? warning : warning.message;
  if (kind === "ExperimentalWarning" && message.startsWith("SQLite is an experimental feature")) return;
  Reflect.apply(emitWarning, process, [warning, ...args]);
}) as typeof process.emitWarning;
const { runCli } = await import("./commands.js");

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

// A detached "rivet daemon start" that outlives this command; its output goes to
// <data>/daemon.log.
async function startDaemon(): Promise<() => boolean> {
  const { spawn } = await import("node:child_process");
  const { mkdirSync, openSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { dataDirFrom } = await import("./client.js");
  const data = dataDirFrom(process.env);
  mkdirSync(data, { recursive: true });
  const log = openSync(join(data, "daemon.log"), "a");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", process.argv[1]!, "daemon", "start"], {
    detached: true, stdio: ["ignore", log, log], windowsHide: true, env: process.env,
  });
  let exited = false;
  child.on("exit", () => { exited = true; });
  child.unref();
  return () => exited;
}

process.exitCode = await runCli(process.argv.slice(2), {
  startDaemon,
  env: process.env,
  cwd: process.cwd(),
  readStdin,
  ...(process.stdin.isTTY ? { ask, tty: { input: process.stdin, output: process.stdout } } : {}),
  raw: (chunk) => process.stdout.write(chunk),
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
});
