// Installs the built Windows installer the way a user would (into a folder whose path has
// spaces), starts the installed app with a data folder holding a database from an
// incompatible Rivet build, and checks that the app loads from a daemon that is up.
// Removes the install afterwards. Windows only: node scripts/desktop-install-smoke.mjs
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") { console.log("desktop install smoke: Windows only, skipped"); process.exit(0); }
const release = fileURLToPath(new URL("../desktop/release/", import.meta.url));
const installer = readdirSync(release).find((f) => /^Rivet Setup .*\.exe$/.test(f));
if (!installer) throw new Error("no Rivet Setup *.exe in desktop/release; run npm run desktop:package first");

const work = join(tmpdir(), `rivet install smoke ${Date.now()}`);
const target = join(work, "Program Files With Spaces", "Rivet");
const data = join(work, "data");
mkdirSync(data, { recursive: true });
const run = (file, args, o = {}) => new Promise((resolve, reject) =>
  execFile(file, args, { windowsHide: true, timeout: 600_000, ...o }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stdout, stderr })) : resolve({ stdout, stderr }))));

// A database another build left behind: the app must still start.
const old = new DatabaseSync(join(data, "rivet.db"));
old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE nodes (run_id TEXT, agent_session_id TEXT)");
for (let v = 1; v <= 200; v++) old.prepare("INSERT INTO schema_migrations VALUES (?, 'then')").run(v);
old.close();

let daemonPid;
try {
  // NSIS: /S silent, /D= the folder (last, unquoted, may hold spaces).
  await run(join(release, installer), ["/S", `/D=${target}`], { windowsVerbatimArguments: true });
  const exe = join(target, "Rivet.exe");
  if (!existsSync(exe)) throw new Error(`installer did not put Rivet.exe in ${target}`);
  const runtimeNode = join(target, "resources", "runtime", "node.exe");
  await run(runtimeNode, ["-v"]);

  const env = { ...process.env, RIVET_DESKTOP_SMOKE: "1", RIVET_DATA_DIR: data, RIVET_RUN_FILE: join(data, "running.json"), RIVET_PORT: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(exe, [], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  app.stdout.on("data", (b) => { said += b; });
  app.stderr.on("data", (b) => { said += b; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { app.kill(); resolve("timeout"); }, 90_000);
    app.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  if (!said.includes("Rivet desktop app loaded from the local daemon")) {
    const log = existsSync(join(data, "daemon.log")) ? readFileSync(join(data, "daemon.log"), "utf8").slice(-2000) : "(no daemon.log)";
    throw new Error(`installed app did not load (exit ${code}):\n${said.slice(-2000)}\ndaemon.log:\n${log}`);
  }
  const info = JSON.parse(readFileSync(join(data, "running.json"), "utf8"));
  daemonPid = info.pid;
  const health = await fetch(`http://127.0.0.1:${info.port}/healthz`).then((r) => r.json());
  if (health.status !== "ok") throw new Error(`daemon not healthy: ${JSON.stringify(health)}`);
  if (!readdirSync(data).some((f) => f.startsWith("rivet.db.incompatible-"))) throw new Error("the incompatible database was not moved aside");
  console.log(JSON.stringify({ installed: target, appLoaded: true, daemon: health, incompatibleDbMovedAside: true }, null, 2));
} finally {
  // Stop the daemon the installed app started, whether or not the checks passed.
  try { daemonPid ??= JSON.parse(readFileSync(join(data, "running.json"), "utf8")).pid; } catch { /* never started */ }
  if (daemonPid) { try { process.kill(daemonPid); } catch { /* already gone */ } }
  const uninstaller = join(target, "Uninstall Rivet.exe");
  if (existsSync(uninstaller)) await run(uninstaller, ["/S"]).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  try { rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
  catch (e) { console.error(`could not remove ${work}: ${e.message}`); }
}
