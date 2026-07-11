#!/usr/bin/env bash
# Stage the production server tree for the desktop bundle (ADR 0012).
#
# Assembles apps/web + its @northkeep/* workspace packages (dist/) + their
# production node_modules into a self-contained folder the bundled Node
# sidecar can run as `node dist/server.js`. Output:
#   apps/desktop/src-tauri/server-tree/   (gitignored)
# which tauri.bundle.conf.json maps into Northkeep.app/Contents/Resources/.
#
# Uses `pnpm deploy` with node-linker=hoisted so the tree is REAL FILES
# (npm-style flat layout, no pnpm symlink store) — required because the
# tree gets copied into a signed .app where every Mach-O must be a plain
# file, and because native addon loaders (better-sqlite3's `bindings`,
# sodium-native's node-gyp-build) walk the real filesystem.
# VERIFIED (2026-07-11, pnpm 11.9.0): the hoisted legacy deploy carries every
# workspace package's dist/ — the ADR's fallback staging script is not needed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="$REPO_ROOT/apps/desktop/src-tauri/server-tree"

# Fail early if the workspace isn't built (deploy would happily copy stale dist).
if [ ! -f "$REPO_ROOT/apps/web/dist/server.js" ]; then
  echo "stage-server: apps/web/dist/server.js missing — run: pnpm build" >&2
  exit 1
fi

rm -rf "$STAGE"
echo "stage-server: pnpm deploy (prod, legacy, hoisted) -> $STAGE"

# `pnpm deploy --prod --filter` rewrites node_modules/.pnpm-workspace-state-v1.json
# at the repo root (records dev:false + filteredInstall:true), after which every
# `pnpm run`/`pnpm build` in the workspace tries to purge and reinstall with
# --production. Verified 2026-07-11 with pnpm 11.9.0. Snapshot the state file
# and restore it after the deploy — the deploy never touches the actual root
# node_modules content, so the pre-deploy state stays accurate.
WS_STATE="$REPO_ROOT/node_modules/.pnpm-workspace-state-v1.json"
WS_STATE_BAK=""
if [ -f "$WS_STATE" ]; then
  WS_STATE_BAK="$(mktemp)"
  cp "$WS_STATE" "$WS_STATE_BAK"
fi
restore_ws_state() {
  if [ -n "$WS_STATE_BAK" ] && [ -f "$WS_STATE_BAK" ]; then
    cp "$WS_STATE_BAK" "$WS_STATE"
    rm -f "$WS_STATE_BAK"
  fi
}
trap restore_ws_state EXIT

pnpm --dir "$REPO_ROOT" --filter @northkeep/web deploy --prod --legacy \
  --config.node-linker=hoisted "$STAGE"

# ---- Prune what the running server never loads -----------------------------
# 1. .bin shims (symlinks; nothing in the bundle execs them, and symlinks are
#    unwelcome inside a signed Resources tree).
rm -rf "$STAGE/node_modules/.bin"
# 2. Foreign-platform prebuilds — for ANY package that ships a prebuilds/ dir
#    (sodium-native, and its bare-* transitive deps). We ship arm64 macOS only;
#    every other platform's binary is dead weight that ALSO fails notarization
#    (unsigned, wrong-arch Mach-O). Keep darwin-arm64 only. Verified 2026-07-11:
#    the first signed build was rejected for exactly these files.
while IFS= read -r -d '' pbdir; do
  find "$pbdir" -mindepth 1 -maxdepth 1 -type d ! -name "darwin-arm64" -exec rm -rf {} +
done < <(find "$STAGE/node_modules" -type d -name prebuilds -print0)
# 3. Bare-runtime binaries. sodium-native ships BOTH a .node (Node.js) and a
#    .bare (the Bare runtime) per platform; bare-inspect/bare-type are
#    Bare-only. We run under Node, so every .bare is unused — prune them all
#    (confirmed: vault crypto still works). This removes the last unsignable
#    Mach-O from the tree; only the two darwin-arm64 .node addons remain.
find "$STAGE/node_modules" -name "*.bare" -delete
# 4. pnpm bookkeeping not needed at runtime.
rm -rf "$STAGE/node_modules/.pnpm" "$STAGE/node_modules/.modules.yaml" 2>/dev/null || true

# ---- Verify the tree is self-contained -------------------------------------
fail=0
for f in \
  "dist/server.js" \
  "dist/static/index.html" \
  "node_modules/@northkeep/core/dist/index.js" \
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
  "node_modules/sodium-native/prebuilds/darwin-arm64/sodium-native.node" \
; do
  if [ ! -f "$STAGE/$f" ]; then
    echo "stage-server: MISSING $f" >&2
    fail=1
  fi
done

# No symlinks may survive into the bundle.
links="$(find "$STAGE" -type l | head -20)"
if [ -n "$links" ]; then
  echo "stage-server: symlinks remain in the staged tree:" >&2
  echo "$links" >&2
  fail=1
fi

# No unsignable Mach-O may survive: a new dependency that ships a .bare or a
# foreign-platform prebuild would otherwise pass staging and only blow up
# after a multi-minute notarization upload. Catch it here instead.
stray="$(find "$STAGE" \( -name "*.bare" -o \
  \( -path "*/prebuilds/*" -name "*.node" ! -path "*/darwin-arm64/*" \) \) | head -20)"
if [ -n "$stray" ]; then
  echo "stage-server: unsignable/foreign native binaries survived pruning:" >&2
  echo "$stray" >&2
  echo "  → extend the prune step (a new dep ships these); notarization would reject them." >&2
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1

echo "stage-server: staged $(du -sh "$STAGE" | cut -f1)  ($(find "$STAGE" -name '*.node' | wc -l | tr -d ' ') native addon(s))"
echo "stage-server: smoke-test it with:"
echo "  NORTHKEEP_HOME=\$(mktemp -d) NORTHKEEP_NO_KEYCHAIN=1 \\"
echo "    apps/desktop/src-tauri/binaries/northkeep-server-aarch64-apple-darwin \\"
echo "    $STAGE/dist/server.js"
