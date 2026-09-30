// Fake agent CLI. Usage: node fake-agent.mjs -- '<json>'
// JSON: { "files"?: { "<path>": "<content>" }, "commit"?: "<message>", "exitCode"?: number }
// Writes the files in the current folder, optionally commits everything, then exits.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const at = process.argv.indexOf("--");
const spec = JSON.parse(at >= 0 ? process.argv[at + 1] ?? "{}" : "{}");

for (const [path, content] of Object.entries(spec.files ?? {})) {
  const full = join(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

if (spec.commit) {
  execFileSync("git", ["add", "-A"], { stdio: "inherit" });
  execFileSync("git", ["commit", "-q", "-m", spec.commit], { stdio: "inherit" });
}

process.exit(spec.exitCode ?? 0);
