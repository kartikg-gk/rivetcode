import { copyFile, chmod, mkdir, mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script through npm run desktop:package");
if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Package the desktop app using Node 24");
const temporary = await mkdtemp(join(tmpdir(), "rivet-desktop-pack-"));
const runtime = join(root, "desktop", "runtime");
await mkdir(runtime, { recursive: true });
const result = execFileSync(process.execPath, [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
  cwd: root, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
});
const [{ filename }] = JSON.parse(result);
execFileSync(process.execPath, [npm, "install", "--prefix", runtime, join(temporary, filename), "--omit=optional", "--no-audit", "--no-fund"], {
  cwd: root, windowsHide: true, stdio: "inherit",
});
const binary = join(runtime, process.platform === "win32" ? "node.exe" : "node");
await copyFile(process.execPath, binary);
await chmod(binary, 0o755);
console.log("Staged desktop runtime at " + dirname(binary));
