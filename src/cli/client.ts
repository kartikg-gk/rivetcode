import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { readRunFile } from "../runfile.js";

export class DaemonDownError extends Error {
  constructor() {
    super("rivet daemon is not running (start it with: rivet daemon start)");
    this.name = "DaemonDownError";
  }
}

export class DaemonError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DaemonError";
  }
}

// The CLI may run inside an agent, so the env it got from the daemon wins over defaults.
export function runFileFrom(env: Record<string, string | undefined>): string {
  const override = env.RIVET_RUN_FILE;
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(homedir(), ".rivet", "running.json");
}

export function dataDirFrom(env: Record<string, string | undefined>): string {
  const override = env.RIVET_DATA_DIR;
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(homedir(), ".rivet", "data");
}

export async function callDaemon(
  env: Record<string, string | undefined>,
  method: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const info = await readRunFile(runFileFrom(env));
  if (!info) throw new DaemonDownError();
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new DaemonDownError();
  }
  const text = await response.text();
  const value: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = (value as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw new DaemonError(response.status, message);
  }
  return value;
}
