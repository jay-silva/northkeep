#!/usr/bin/env bash
# Build the distributable Northkeep desktop app (.app + DMG) — ADR 0012.
#
# Usage:
#   scripts/desktop-bundle/build.sh              # .app + .dmg
#   scripts/desktop-bundle/build.sh --bundles app  # .app only (faster smoke)
#
# Unsigned local build: run with no signing env vars set.
# Signed + notarized release: export APPLE_SIGNING_IDENTITY, APPLE_ID,
# APPLE_PASSWORD, APPLE_TEAM_ID first — see scripts/desktop-bundle/README.md.
# Credentials are read from the environment only; never hardcoded, never
# echoed.
#
# Bundling config lives in apps/desktop/src-tauri/tauri.bundle.conf.json and
# is merged in via --config, so plain `pnpm tauri dev` / `pnpm tauri build`
# stay usable without the sidecar staged.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/scripts/desktop-bundle"

# rustup installs land in ~/.cargo/bin, which non-login shells may not have.
if ! command -v cargo >/dev/null 2>&1 && [ -x "$HOME/.cargo/bin/cargo" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

echo "==> [1/5] Building the workspace (pnpm build)"
pnpm --dir "$REPO_ROOT" build

echo "==> [2/5] Fetching the pinned Node sidecar"
"$HERE/fetch-node.sh"

echo "==> [3/5] Staging the production server tree"
"$HERE/stage-server.sh"

echo "==> [4/5] Pre-signing native binaries (skips when unsigned)"
"$HERE/presign.sh"

echo "==> [5/5] tauri build"
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "    signing enabled (identity from env, not shown)"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    echo "    notarization enabled (Apple ID flow)"
  elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    echo "    notarization enabled (App Store Connect API key flow)"
  else
    echo "    NOTE: no notarization credentials in env — the DMG will be signed but NOT notarized"
  fi
else
  echo "    APPLE_SIGNING_IDENTITY not set — building UNSIGNED (local test only)"
fi

# Invoke the Tauri CLI binary directly (not `pnpm tauri`): pnpm's
# run-wrapper adds a deps-status check that can try to purge/reinstall
# node_modules mid-build when it runs without a TTY.
cd "$REPO_ROOT/apps/desktop"
./node_modules/.bin/tauri build --config src-tauri/tauri.bundle.conf.json "$@"

echo
echo "Artifacts:"
ls -d "$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/macos/"*.app 2>/dev/null || true
ls "$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/dmg/"*.dmg 2>/dev/null || true
