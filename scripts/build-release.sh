#!/usr/bin/env bash
# Builds self-contained agentmgr bundles (Node runtime + app + node_modules).
# Usage: scripts/build-release.sh <out-dir> [target...]
#   targets: darwin-arm64 darwin-x64 linux-x64 (linux-x64 must be built on linux-x64)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${1:?out dir}" && cd "$1" && pwd); shift
TARGETS=("${@:-darwin-arm64 darwin-x64}")
NODE_VERSION=${NODE_VERSION:-22.22.0}
VERSION=$(node -p "require('$ROOT/package.json').version")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Install production deps once from the app source.
mkdir -p "$WORK/app"
cp -R "$ROOT/bin" "$ROOT/src" "$ROOT/public" "$ROOT/scripts" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/README.md" "$WORK/app/"
(cd "$WORK/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)

for t in ${TARGETS[@]}; do
  echo "==> $t"
  name="agentmanager-$VERSION-$t"
  dest="$WORK/$name"
  mkdir -p "$dest/runtime" "$dest/bin"
  cp -R "$WORK/app" "$dest/app"

  pty="$dest/app/node_modules/node-pty"
  if [[ $t == linux-* ]]; then
    # No linux prebuilds ship with node-pty; compile against the bundled Node.
    (cd "$pty" && npx --yes node-gyp@11 rebuild --target="$NODE_VERSION" >/dev/null)
    rm -rf "$pty/prebuilds"
  else
    find "$pty/prebuilds" -mindepth 1 -maxdepth 1 ! -name "$t" -exec rm -rf {} +
    chmod 755 "$pty/prebuilds/$t/spawn-helper"
  fi

  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$t.tar.gz" \
    | tar -xz -C "$WORK" "node-v$NODE_VERSION-$t/bin/node"
  mv "$WORK/node-v$NODE_VERSION-$t/bin/node" "$dest/runtime/node"
  rm -rf "$WORK/node-v$NODE_VERSION-$t"

  cat > "$dest/bin/agentmgr" <<'SH'
#!/bin/sh
# Resolve symlinks so `ln -s .../bin/agentmgr ~/.local/bin/agentmgr` works.
SELF=$0
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case $LINK in /*) SELF=$LINK ;; *) SELF=$(dirname "$SELF")/$LINK ;; esac
done
DIR=$(cd "$(dirname "$SELF")/.." && pwd)
exec "$DIR/runtime/node" "$DIR/app/bin/agentmgr.js" "$@"
SH
  chmod 755 "$dest/bin/agentmgr"

  tar -czf "$OUT/$name.tar.gz" -C "$WORK" "$name"
  rm -rf "$dest"
  echo "    $OUT/$name.tar.gz ($(du -h "$OUT/$name.tar.gz" | cut -f1))"
done
