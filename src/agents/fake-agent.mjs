// Fake agent CLI. Usage: node fake-agent.mjs -- '<json>'
// JSON: {
//   "files"?: { "<path>": "<content>" },  write these in the current folder
//   "commit"?: "<message>",               then commit everything
//   "dumpEnv"?: true,                      write the RIVET_* environment to env.json
//   "listen"?: true,                       append stdin lines to inbox.txt until "/exit"
//   "stayFor"?: <ms>,                      otherwise keep running this long
//   "exitCode"?: number
// }
// Prints one line per action so tests can read its output.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const at = process.argv.indexOf("--");
const spec = JSON.parse(at >= 0 ? process.argv[at + 1] ?? "{}" : "{}");
const exit = () => process.exit(spec.exitCode ?? 0);

for (const [path, content] of Object.entries(spec.files ?? {})) {
  const full = join(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  console.log(`wrote ${path}`);
}

if (spec.commit) {
  execFileSync("git", ["add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", spec.commit], { stdio: "ignore" });
  console.log("committed");
}

if (spec.dumpEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("RIVET_")));
  writeFileSync(join(process.cwd(), "env.json"), JSON.stringify(env, null, 2));
}

if (spec.listen) {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line === "/exit") {
      lines.close();
      exit();
    }
    appendFileSync(join(process.cwd(), "inbox.txt"), line + "\n");
    console.log(`got ${line}`);
  });
  lines.on("close", exit);
} else if (spec.stayFor) {
  setTimeout(exit, spec.stayFor);
} else {
  exit();
}
