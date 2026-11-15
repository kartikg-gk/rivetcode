// After a release is published (GitHub release + npm), writes what the package managers
// need, with the checksums of the released files:
//   packaging/out/homebrew/Formula/rivet.rb     -> your homebrew-tap repo (brew install kartikg-gk/tap/rivet)
//   packaging/out/scoop/rivet.json              -> your scoop bucket repo (scoop install rivet)
//   packaging/out/winget/<version>/*.yaml       -> a pull request to microsoft/winget-pkgs
// Usage: node scripts/package-managers.mjs [version]   (default: package.json's)
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = process.argv[2] ?? pkg.version;
const owner = "kartikg-gk", repo = "rivetcode";
const site = `https://${owner}.github.io/${repo}/`;
const release = `https://github.com/${owner}/${repo}/releases/download/v${version}`;
const npmTarball = `https://registry.npmjs.org/rivet-code/-/rivet-code-${version}.tgz`;
const setupExe = `${release}/Rivet-Setup-${version}.exe`;
const portableExe = `${release}/Rivet-${version}-portable.exe`;
const description = "Run coding agents on your own machine, each in its own copy of your project, from one app in your browser.";

async function sha256(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (is the release published?)`);
  return createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
}

console.log(`Checksums for ${version}...`);
const [npmSha, setupSha, portableSha] = await Promise.all([sha256(npmTarball), sha256(setupExe), sha256(portableExe)]);
const out = join(root, "packaging", "out");

// Homebrew: the command line, on Homebrew's Node.
await mkdir(join(out, "homebrew", "Formula"), { recursive: true });
await writeFile(join(out, "homebrew", "Formula", "rivet.rb"), `class Rivet < Formula
  desc "${description}"
  homepage "${site}"
  url "${npmTarball}"
  sha256 "${npmSha}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/rivet"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/rivet --version")
  end
end
`);

// Scoop: the desktop app, as its portable build.
await mkdir(join(out, "scoop"), { recursive: true });
await writeFile(join(out, "scoop", "rivet.json"), JSON.stringify({
  version, description, homepage: site, license: "MIT",
  url: `${portableExe}#/Rivet.exe`, hash: portableSha,
  shortcuts: [["Rivet.exe", "Rivet"]],
  checkver: { github: `https://github.com/${owner}/${repo}` },
  autoupdate: { url: `https://github.com/${owner}/${repo}/releases/download/v$version/Rivet-$version-portable.exe#/Rivet.exe` },
}, null, 2) + "\n");

// winget: the desktop app's installer, per user, silent.
const id = "KartikG.Rivet";
const dir = join(out, "winget", version);
await mkdir(dir, { recursive: true });
await writeFile(join(dir, `${id}.yaml`), `PackageIdentifier: ${id}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`);
await writeFile(join(dir, `${id}.installer.yaml`), `PackageIdentifier: ${id}
PackageVersion: ${version}
InstallerType: nullsoft
Scope: user
InstallerSwitches:
  Silent: /S /currentuser
  SilentWithProgress: /S /currentuser
Installers:
- Architecture: x64
  InstallerUrl: ${setupExe}
  InstallerSha256: ${setupSha.toUpperCase()}
ManifestType: installer
ManifestVersion: 1.6.0
`);
await writeFile(join(dir, `${id}.locale.en-US.yaml`), `PackageIdentifier: ${id}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: kartikg-gk
PublisherUrl: https://github.com/${owner}
PackageName: Rivet
PackageUrl: ${site}
License: MIT
LicenseUrl: https://github.com/${owner}/${repo}/blob/main/LICENSE
ShortDescription: ${description}
Tags:
- ai
- coding-agents
- claude-code
- codex
ReleaseNotesUrl: https://github.com/${owner}/${repo}/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`);
console.log(`Wrote ${out}`);
