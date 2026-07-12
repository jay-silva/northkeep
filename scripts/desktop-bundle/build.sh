#!/usr/bin/env bash
# Build the distributable NorthKeep desktop app (.app + DMG) — ADR 0012.
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

# Staple the notarization tickets (verified 2026-07-11: Tauri notarizes the
# .app but staples NEITHER the .app nor the DMG). Stapling embeds the ticket
# so Gatekeeper accepts the app OFFLINE; without it, a downloader with no
# network at launch is blocked. Only runs when we actually signed+notarized.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && { [ -n "${APPLE_PASSWORD:-}" ] || [ -n "${APPLE_API_KEY:-}" ]; }; then
  APP_OUT="$(ls -d "$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/macos/"*.app 2>/dev/null | head -1)"
  DMG_OUT="$(ls "$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/dmg/"*.dmg 2>/dev/null | head -1)"

  # 1. Staple the .app (Tauri already got its ticket from notarization).
  if [ -n "$APP_OUT" ]; then
    echo "==> stapling $(basename "$APP_OUT")"
    xcrun stapler staple "$APP_OUT"
  fi

  # 2. The DMG was built from the unstapled .app and never notarized on its
  #    own. Rebuild it around the now-stapled .app, then notarize + staple the
  #    DMG itself — so both the download and the app inside verify offline.
  if [ -n "$DMG_OUT" ] && [ -n "$APP_OUT" ]; then
    echo "==> rebuilding the DMG around the stapled app"
    STAGING="$(mktemp -d)"
    cp -R "$APP_OUT" "$STAGING/"
    ln -s /Applications "$STAGING/Applications"
    rm -f "$DMG_OUT"
    hdiutil create -volname "NorthKeep" -srcfolder "$STAGING" -ov -format UDZO "$DMG_OUT" >/dev/null
    rm -rf "$STAGING"
    codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$DMG_OUT"
    echo "==> notarizing the DMG"
    if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
      xcrun notarytool submit "$DMG_OUT" --key "$APPLE_API_KEY" --key-id "${APPLE_API_KEY_ID:-}" --issuer "$APPLE_API_ISSUER" --wait
    else
      xcrun notarytool submit "$DMG_OUT" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
    fi
    xcrun stapler staple "$DMG_OUT"
  fi
fi

echo
echo "Artifacts:"
ls -d "$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/macos/"*.app 2>/dev/null || true
ls "$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/dmg/"*.dmg 2>/dev/null || true
