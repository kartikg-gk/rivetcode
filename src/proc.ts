import { execFile } from "node:child_process";

// Signals a process and everything it started. On POSIX the child must have been
// spawned detached (its own process group); on Windows the whole tree is ended.
export function signalTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}
