import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";

const main = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
beforeAll(() => { execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.build.json"], { cwd: fileURLToPath(new URL("..", import.meta.url)) }); }, 120000);
it("reports the package version and suppresses only the SQLite experimental warning", () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const script = `import { pathToFileURL } from 'node:url'; process.argv = [process.execPath, ${JSON.stringify(main)}, '--version']; await import(pathToFileURL(${JSON.stringify(main)}).href); await import('node:sqlite'); process.emitWarning('unrelated warning stays visible');`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(version);
  expect(result.stderr).not.toMatch(/SQLite.*experimental/i);
  expect(result.stderr).toContain("unrelated warning stays visible");
});
