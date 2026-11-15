# Rivet installer for Windows (PowerShell):
#   irm https://kartikg-gk.github.io/rivetcode/install.ps1 | iex
# Puts a private Node.js 24 and Rivet under ~\.rivet and a `rivet` command in ~\.rivet\bin,
# which is added to your user PATH. `rivet uninstall` and deleting ~\.rivet undo it.
# $env:RIVET_VERSION pins a version, $env:RIVET_HOME moves the install, $env:RIVET_PACKAGE
# installs a local package file instead of the npm release (for testing).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$home_ = if ($env:RIVET_HOME) { $env:RIVET_HOME } else { Join-Path $HOME '.rivet' }
$version = if ($env:RIVET_VERSION) { $env:RIVET_VERSION } else { 'latest' }
$package = if ($env:RIVET_PACKAGE) { $env:RIVET_PACKAGE } else { "rivet-code@$version" }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

function Fail($message) { Write-Host "rivet install: $message" -ForegroundColor Red; throw $message }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("rivet-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading Node.js 24 for win-$arch..."
  $dist = 'https://nodejs.org/dist/latest-v24.x'
  $sums = (Invoke-WebRequest -UseBasicParsing "$dist/SHASUMS256.txt").Content
  $line = ($sums -split "`n") | Where-Object { $_ -match "node-v24[^ ]*-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Fail "no Node.js 24 build for win-$arch" }
  $want, $file = ($line.Trim() -split '\s+')
  $zip = Join-Path $tmp $file
  Invoke-WebRequest -UseBasicParsing "$dist/$file" -OutFile $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $want.ToLower()) { Fail 'the Node.js download did not match its checksum' }

  $runtime = Join-Path $home_ 'runtime'
  $nodeDir = Join-Path $runtime 'node'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $unpacked = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'node-v24*' } | Select-Object -First 1
  $new = $unpacked.FullName

  # Rivet goes into the new copy first; the old one is replaced only once that worked, so a
  # failed reinstall or update leaves the working install as it was.
  Write-Host "Installing Rivet ($package)..."
  & (Join-Path $new 'node.exe') (Join-Path $new 'node_modules\npm\bin\npm-cli.js') install -g --prefix $new --no-audit --no-fund --update-notifier=false --loglevel=error $package
  if ($LASTEXITCODE -ne 0) { Fail 'npm could not install Rivet; nothing was changed' }
  if (-not (Test-Path (Join-Path $new 'node_modules\rivet-code\dist\cli\main.js'))) { Fail 'Rivet did not install; nothing was changed' }

  # A running Rivet holds node.exe; it is stopped first so the files can be replaced.
  $oldMain = Join-Path $nodeDir 'node_modules\rivet-code\dist\cli\main.js'
  # "not running" on stderr is fine here; Windows PowerShell would otherwise stop on it.
  if (Test-Path $oldMain) {
    $ErrorActionPreference = 'Continue'
    try { & (Join-Path $nodeDir 'node.exe') $oldMain daemon stop 2>&1 | Out-Null } catch { }
    $ErrorActionPreference = 'Stop'
  }
  if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
  Move-Item $new $nodeDir
  $node = Join-Path $nodeDir 'node.exe'
  $main = Join-Path $nodeDir 'node_modules\rivet-code\dist\cli\main.js'

  $bin = Join-Path $home_ 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Set-Content -Encoding ASCII -Path (Join-Path $bin 'rivet.cmd') -Value "@echo off`r`nrem installed by the Rivet installer`r`n`"$node`" --disable-warning=ExperimentalWarning `"$main`" %*"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($env:RIVET_NO_PATH -ne '1' -and -not (($userPath -split ';') -contains $bin)) {
    [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $bin), 'User')
    Write-Host "Added $bin to your user PATH (new terminals pick it up)."
  }
  if (-not (($env:Path -split ';') -contains $bin)) { $env:Path = "$env:Path;$bin" }

  $installed = & (Join-Path $bin 'rivet.cmd') --version
  Write-Host ""
  Write-Host "Rivet $installed is installed. Start it with: rivet"
  Write-Host "Rivet uses the agents you already have: Claude Code or Codex, installed and logged in."
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
