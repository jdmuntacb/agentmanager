#!/bin/sh
# Agent Manager installer: curl -fsSL <site>/install.sh | sh
set -eu
BASE=${AGENTMGR_BASE:-__BASE__}
PREFIX=${AGENTMGR_HOME:-$HOME/.agentmanager}
BIN_DIR=${AGENTMGR_BIN:-$HOME/.local/bin}

os=$(uname -s); arch=$(uname -m)
case "$os-$arch" in
  Darwin-arm64) t=darwin-arm64 ;;
  Darwin-x86_64) t=darwin-x64 ;;
  Linux-x86_64) t=linux-x64 ;;
  *) echo "Unsupported platform: $os $arch. Install from source: npm install && npm link" >&2; exit 1 ;;
esac

echo "Downloading Agent Manager ($t)..."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fL --progress-bar "$BASE/downloads/agentmanager-$t.tar.gz" -o "$tmp/am.tar.gz"
tar -xzf "$tmp/am.tar.gz" -C "$tmp"
rm -rf "$PREFIX"; mkdir -p "$(dirname "$PREFIX")" "$BIN_DIR"
mv "$tmp"/agentmanager-*-"$t" "$PREFIX"
ln -sf "$PREFIX/bin/agentmgr" "$BIN_DIR/agentmgr"

echo "Installed agentmgr -> $BIN_DIR/agentmgr"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
command -v claude >/dev/null 2>&1 || echo "Note: Agent Manager drives the Claude Code CLI. Install it: https://claude.com/claude-code"
echo "Start it:  agentmgr ui"
