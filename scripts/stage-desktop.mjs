import { copyFile, chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script through npm run desktop:package");
if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Package the desktop app using Node 24");
const temporary = await mkdtemp(join(tmpdir(), "rivet-desktop-pack-"));
const runtime = join(root, "desktop", "runtime");
// Start empty: what an earlier build staged (an old package name, removed dependencies)
// must not ship in this one.
await rm(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
await mkdir(runtime, { recursive: true });
const result = execFileSync(process.execPath, [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
  cwd: root, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
});
const [{ filename }] = JSON.parse(result);
execFileSync(process.execPath, [npm, "install", "--prefix", runtime, join(temporary, filename), "--no-audit", "--no-fund"], {
  cwd: root, windowsHide: true, stdio: "inherit",
});

// The window shows the web app the daemon serves; a package without it must not ship.
const page = join(runtime, "node_modules", "rivet-code", "dist", "web", "index.html");
if (!existsSync(page)) throw new Error("the packed rivet-code has no dist/web/index.html; run the build again before packaging");

// Type declarations, source maps and docs never run; leaving them out roughly halves the
// files the installer has to write.
const UNUSED = /\.(d\.ts|d\.mts|d\.cts|map|md|markdown)$/i;
let removed = 0;
async function prune(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await prune(path);
    else if (entry.isFile() && UNUSED.test(entry.name)) { await rm(path); removed++; }
  }
}
await prune(join(runtime, "node_modules"));

const binary = join(runtime, process.platform === "win32" ? "node.exe" : "node");
await copyFile(process.execPath, binary);
await chmod(binary, 0o755);
console.log(`Staged desktop runtime at ${dirname(binary)} (${removed} unused files left out)`);
