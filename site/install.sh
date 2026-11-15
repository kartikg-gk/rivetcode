#!/bin/sh
# Rivet installer for macOS and Linux:
#   curl -fsSL https://kartikg-gk.github.io/rivetcode/install.sh | sh
# Puts a private Node.js 24 and Rivet under ~/.rivet and a `rivet` command in ~/.local/bin.
# Nothing else on the machine changes; `rivet uninstall` and deleting ~/.rivet undo it.
# RIVET_VERSION pins a version, RIVET_HOME moves the install, RIVET_PACKAGE installs a
# local package file instead of the npm release (for testing).
set -eu

RIVET_HOME="${RIVET_HOME:-$HOME/.rivet}"
BIN_DIR="${RIVET_BIN_DIR:-$HOME/.local/bin}"
VERSION="${RIVET_VERSION:-latest}"
PACKAGE="${RIVET_PACKAGE:-rivet-code@$VERSION}"
MARK="# installed by the Rivet installer"

say() { printf '%s\n' "$*"; }
fail() { printf 'rivet install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs $1"; }
need curl; need tar; need uname

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "this script is for macOS and Linux; on Windows run: irm https://kartikg-gk.github.io/rivetcode/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported processor: $(uname -m)" ;;
esac

if [ -e "$BIN_DIR/rivet" ] && ! grep -q "$MARK" "$BIN_DIR/rivet" 2>/dev/null; then
  fail "$BIN_DIR/rivet exists and was not made by this installer; remove it or set RIVET_BIN_DIR"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading Node.js 24 for $os-$arch..."
dist="https://nodejs.org/dist/latest-v24.x"
curl -fsSL "$dist/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
file="$(grep -o "node-v24[^ ]*-$os-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n 1)"
[ -n "$file" ] || fail "no Node.js 24 build for $os-$arch"
curl -fsSL "$dist/$file" -o "$tmp/$file"
want="$(grep " $file\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$file" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)"; fi
[ "$want" = "$got" ] || fail "the Node.js download did not match its checksum"

node_dir="$RIVET_HOME/runtime/node"
rm -rf "$node_dir.new"
mkdir -p "$node_dir.new"
tar -xzf "$tmp/$file" -C "$node_dir.new" --strip-components=1
rm -rf "$node_dir"
mv "$node_dir.new" "$node_dir"
node="$node_dir/bin/node"

say "Installing Rivet ($PACKAGE)..."
"$node" "$node_dir/lib/node_modules/npm/bin/npm-cli.js" install -g --prefix "$node_dir" --no-audit --no-fund --update-notifier=false --loglevel=error "$PACKAGE"
main="$node_dir/lib/node_modules/rivet-code/dist/cli/main.js"
[ -f "$main" ] || fail "Rivet did not install"

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/rivet" <<EOF
#!/bin/sh
$MARK
exec "$node" --disable-warning=ExperimentalWarning "$main" "\$@"
EOF
chmod +x "$BIN_DIR/rivet"

say ""
say "Rivet $("$BIN_DIR/rivet" --version) is installed."
case ":$PATH:" in
  *":$BIN_DIR:"*) say "Start it with: rivet" ;;
  *)
    shell_rc="$HOME/.profile"
    case "${SHELL:-}" in *zsh) shell_rc="$HOME/.zshrc" ;; *bash) shell_rc="$HOME/.bashrc" ;; esac
    say "$BIN_DIR is not on your PATH yet. Add it with:"
    say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> $shell_rc && . $shell_rc"
    say "then start Rivet with: rivet   (or now: $BIN_DIR/rivet)"
    ;;
esac
say "Rivet uses the agents you already have: Claude Code or Codex, installed and logged in."
