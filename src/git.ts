import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

// Runs the real git binary without a shell, so paths with spaces need no quoting.
export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === "number" ? err.code : null;
          reject(new GitError(args, code, String(stderr)));
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}
