// Fake agent CLI. Usage: node fake-agent.mjs -- '<json>'
// JSON: {
//   "files"?: { "<path>": "<content>" },  write these in the current folder
//   "commit"?: "<message>",               then commit everything
//   "dumpEnv"?: true,                      write the RIVET_* environment to env.json
//   "listen"?: true,                       append stdin lines to inbox.txt until "/exit"
//   "stayFor"?: <ms>,                      otherwise keep running this long
//   "exitCode"?: number,
//   "failUntilAttempt"?: n                 exit 1 at once while RIVET_ATTEMPT < n
// }
// Prints one line per action so tests can read its output.
import { execFileSync } from "node:child_process";
import { existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const at = process.argv.indexOf("--");
// The script is the whole prompt, or the JSON object inside a longer one (a task built
// around it, such as one from an issue).
const raw = at >= 0 ? process.argv[at + 1] ?? "{}" : "{}";
const spec = (() => {
  try { return JSON.parse(raw); } catch { return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); }
})();
const exit = () => process.exit(spec.exitCode ?? 0);

if (spec.failUntilAttempt && Number(process.env.RIVET_ATTEMPT ?? 0) < spec.failUntilAttempt) {
  console.log(`failing on purpose (attempt ${process.env.RIVET_ATTEMPT})`);
  process.exit(1);
}

for (const [path, content] of Object.entries(spec.files ?? {})) {
  const full = join(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  console.log(`wrote ${path}`);
}

if (spec.commit) {
  execFileSync("git", ["add", "-A"], { stdio: "ignore" });
  // A retry may have nothing new to commit; that is not an error.
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" }).trim();
  if (staged) {
    execFileSync("git", ["commit", "-q", "-m", spec.commit], { stdio: "ignore" });
    console.log("committed");
  }
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
} else if (spec.finishGate) {
  const timer = setInterval(() => {
    if (!existsSync(spec.finishGate)) return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: spec.finalReply } }) + "\n", exit);
  }, 25);
} else if (spec.stayFor) {
  setTimeout(exit, spec.stayFor);
} else {
  exit();
}
