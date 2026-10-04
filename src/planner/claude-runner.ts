import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { signalTree } from "../proc.js";
import type { PlannerRunner } from "./planner.js";

// The planner only reads the repository.
export const PLANNER_TOOLS = ["Read", "Grep", "Glob"];

// A headless claude in the repo, read-only, keeping one conversation so the fix
// attempt sees the first answer.
export function claudePlanner(o: { binary: string; repo: string; model?: string; timeoutMs?: number }): PlannerRunner {
  const conversation = randomUUID();
  const timeoutMs = o.timeoutMs ?? 10 * 60_000;
  return (prompt, { resume }) => new Promise((resolve, reject) => {
    const args = [
      ...(resume ? ["--resume", conversation] : ["--session-id", conversation]),
      "-p",
      ...(o.model ? ["--model", o.model] : []),
      "--allowedTools", PLANNER_TOOLS.join(","),
      "--", prompt,
    ];
    const child = spawn(o.binary, args, {
      cwd: o.repo, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString("utf8"); });
    const timer = setTimeout(() => { if (child.pid) signalTree(child.pid, "SIGKILL"); }, timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`planner exited with code ${code}: ${(err || out).trim().slice(-2000)}`));
    });
  });
}
