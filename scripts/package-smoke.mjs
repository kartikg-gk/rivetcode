import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this check with npm run smoke:package");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const work = await mkdtemp(join(tmpdir(), "rivet-package-"));
const packDir = process.argv[2] ? resolve(process.argv[2]) : join(work, "pack");
await mkdir(packDir, { recursive: true });
function run(args, cwd = root, env = process.env) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd, env, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${args.join(" ")} failed: ${result.stderr} ${result.stdout}`);
  return result.stdout;
}
run(["run", "build"]);
const dry = JSON.parse(run(["pack", "--dry-run", "--json", "--ignore-scripts"]))[0];
if (dry.files.some((f) => !["package.json", "LICENSE", "README.md"].includes(f.path) && !f.path.startsWith("dist/") && !f.path.startsWith("bin/"))) throw new Error("unexpected package contents");
const packed = JSON.parse(run(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir]))[0];
const archive = join(packDir, packed.filename);
const install = join(work, "install"); await mkdir(install);
run(["install", "--prefix", install, "--omit=dev", "--omit=optional", "--no-audit", "--no-fund", archive], work);
const installed = join(install, "node_modules", ...pkg.name.split("/"));
const sdkDir = join(install, "node_modules", "@anthropic-ai");
const sdkPackages = await readdir(sdkDir).catch(() => []);
if (sdkPackages.some((n) => n.startsWith("claude-agent-sdk-") && !n.endsWith("sdk"))) throw new Error("optional native agent binary was installed");
const env = { ...process.env, RIVET_DATA_DIR: join(work, "data"), RIVET_RUN_FILE: join(work, "running.json"), RIVET_NO_AUTOSTART: "1" };
const binary = join(installed, "dist", "cli", "main.js");
const version = spawnSync(process.execPath, [binary, "--version"], { cwd: work, env, encoding: "utf8", windowsHide: true });
if (version.status !== 0 || version.stdout.trim() !== pkg.version) throw new Error("installed CLI version check failed");
const doctor = spawnSync(process.execPath, [binary, "doctor"], { cwd: work, env, encoding: "utf8", windowsHide: true, timeout: 60000 });
if (doctor.status !== 0 || /ExperimentalWarning.*SQLite|SQLite.*experimental/i.test(doctor.stderr)) throw new Error(`installed doctor failed: ${doctor.stdout} ${doctor.stderr}`);
async function bytes(path) { const info = await stat(path); if (!info.isDirectory()) return info.size; let total = 0; for (const name of await readdir(path)) total += await bytes(join(path, name)); return total; }
console.log(JSON.stringify({ archive, packageBytes: packed.size, installedBytes: await bytes(join(install, "node_modules")), optionalNativeAgent: false, version: pkg.version, doctor: "passed", scratch: work }, null, 2));
