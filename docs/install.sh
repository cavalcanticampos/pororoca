#!/bin/sh
# Pororoca installer: curl -fsSL https://cavalcanticampos.github.io/pororoca/install.sh | sh
# Downloads the latest release binary for this machine, checks its SHA-256 and puts it in
# $POROROCA_INSTALL_DIR (default ~/.local/bin). Set POROROCA_VERSION=v0.1.0 to pin a version.
set -eu

REPO="cavalcanticampos/pororoca"
DIR="${POROROCA_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${POROROCA_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
fail() { printf 'pororoca install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s); Linux and macOS are supported (Windows: use WSL)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac
# Rosetta: prefer the native arm64 build on Apple silicon
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi

asset="pororoca-$os-$arch"
if [ "$VERSION" = latest ]; then url="https://github.com/$REPO/releases/latest/download"; else url="https://github.com/$REPO/releases/download/$VERSION"; fi

command -v curl >/dev/null 2>&1 || fail "curl is required"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading $asset ($VERSION)…"
curl -fsSL "$url/$asset" -o "$tmp/$asset" || fail "download failed: $url/$asset"
curl -fsSL "$url/checksums.txt" -o "$tmp/checksums.txt" || fail "download failed: $url/checksums.txt"

expected="$(grep " $asset\$" "$tmp/checksums.txt" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "no checksum for $asset"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"; else actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset"

mkdir -p "$DIR"
mv "$tmp/$asset" "$DIR/pororoca"
chmod +x "$DIR/pororoca"
say "Installed $("$DIR/pororoca" version) at $DIR/pororoca"

case ":$PATH:" in
  *":$DIR:"*) ;;
  *)
    case "$(basename "${SHELL:-}")" in
      zsh) rc="~/.zshrc" ;;
      bash) rc="~/.bashrc" ;;
      fish) rc="" ;;
      *) rc="~/.profile" ;;
    esac
    say ""
    say "Add it to your PATH:"
    if [ -n "$rc" ]; then say "  echo 'export PATH=\"$DIR:\$PATH\"' >> $rc && export PATH=\"$DIR:\$PATH\""; else say "  fish_add_path $DIR"; fi
    ;;
esac

say ""
say "Next:"
say "  pororoca demo      # see a fleet work, no accounts needed"
say "  pororoca doctor    # check Claude Code, gh and git"
say "  mkdir my-fleet && cd my-fleet && pororoca init"
