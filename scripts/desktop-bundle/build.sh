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

# Load signing credentials from a local, gitignored file if present. Env vars
# set in a shell don't survive to a new terminal, which silently produces an
# UNSIGNED build; a file source makes every build reproducible. `.env.local` is
# covered by the .env.* gitignore rule — it must never be committed. Values are
# read here and never echoed.
ENV_LOCAL="$HERE/.env.local"
if [ -f "$ENV_LOCAL" ]; then
  set -a; . "$ENV_LOCAL"; set +a
  echo "build: loaded signing credentials from scripts/desktop-bundle/.env.local"
fi

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
  # The .app is always NorthKeep.app (no version in the name), so head -1 is fine.
  APP_OUT="$(ls -d "$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/macos/"*.app 2>/dev/null | head -1)"

  # Pick the DMG deterministically. After a version bump two DMGs can coexist,
  # and a lexical `head -1` could staple the STALE one, leaving the real release
  # unstapled. Prefer the exact version-matched file (version read from
  # tauri.conf.json, no jq needed); fall back to newest-by-mtime only if the
  # version can't be read. Tauri names it <productName>_<version>_<arch>.dmg.
  DMG_DIR="$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/dmg"
  TAURI_CONF="$REPO_ROOT/apps/desktop/src-tauri/tauri.conf.json"
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TAURI_CONF" | head -1)"
  all_dmgs=("$DMG_DIR/"*.dmg)
  if [ ! -e "${all_dmgs[0]}" ]; then
    # No DMG at all (e.g. a signed `build.sh --bundles app` smoke build). Nothing
    # to staple; leave DMG_OUT empty so the guard below skips the DMG steps,
    # exactly as the old code did on an empty match.
    DMG_OUT=""
  elif [ -n "$VERSION" ]; then
    dmg_matches=("$DMG_DIR/"*_"${VERSION}"_*.dmg)
    if [ ! -e "${dmg_matches[0]}" ]; then
      # DMGs exist but none match this version: a stale DMG from another version
      # is present and the current release DMG is missing. Fail loudly rather
      # than staple the wrong file.
      echo "build: FATAL: DMGs exist in $DMG_DIR but none match version ${VERSION}." >&2
      echo "  A stale DMG is present and the current release DMG is missing; refusing to guess." >&2
      exit 1
    fi
    if [ "${#dmg_matches[@]}" -gt 1 ]; then
      echo "build: FATAL: ${#dmg_matches[@]} DMGs match version ${VERSION}; refusing to guess:" >&2
      printf '    %s\n' "${dmg_matches[@]}" >&2
      exit 1
    fi
    DMG_OUT="${dmg_matches[0]}"
  else
    echo "build: WARNING: could not read version from tauri.conf.json; using newest DMG by mtime." >&2
    DMG_OUT="$(ls -t "$DMG_DIR/"*.dmg 2>/dev/null | head -1)"
  fi

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
      # notarytool: --key wants the .p8 FILE PATH, --key-id wants the key id.
      # (Matches the README's APPLE_API_KEY_PATH/APPLE_API_KEY convention.) No
      # app-specific password on argv here — the key file is the credential.
      xcrun notarytool submit "$DMG_OUT" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
    else
      # Do NOT pass --password to the submit call: with --wait it runs for
      # minutes, and an app-specific password on argv is readable by any local
      # process via `ps` for that whole window. Instead stash the credential once
      # in a keychain profile, then submit against the profile with NO secret on
      # the long-running command. store-credentials still puts the password on
      # argv, but only for that one fast call (task-accepted); it writes to the
      # login keychain and overwrites the profile each run, so it is idempotent.
      NOTARY_PROFILE="northkeep-notary"
      xcrun notarytool store-credentials "$NOTARY_PROFILE" \
        --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" >/dev/null
      xcrun notarytool submit "$DMG_OUT" --keychain-profile "$NOTARY_PROFILE" --wait
    fi
    xcrun stapler staple "$DMG_OUT"
  fi
fi

echo
echo "Artifacts:"
ls -d "$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/macos/"*.app 2>/dev/null || true
ls "$REPO_ROOT/apps/desktop/src-tauri/target/release/bundle/dmg/"*.dmg 2>/dev/null || true
