#!/usr/bin/env bash
# Pre-sign every Mach-O that Tauri's bundler won't sign itself (ADR 0012).
#
# Notarization rejects any unsigned Mach-O in the bundle. Tauri signs the
# app, frameworks, and executables — but not arbitrary .node files inside
# Resources/. So before `tauri build` we sign, in the staging tree:
#   - every *.node native addon in server-tree/
#   - the staged Node sidecar binary
# The signatures travel with the copied files; the outer app signature
# seals them.
#
# Requires APPLE_SIGNING_IDENTITY (e.g. "Developer ID Application: Jason
# Silva (TEAMID)") in the environment. When it is unset this script skips
# gracefully so unsigned local builds keep working. The identity value is
# never echoed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="$REPO_ROOT/apps/desktop/src-tauri/server-tree"
BIN_DIR="$REPO_ROOT/apps/desktop/src-tauri/binaries"

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "presign: APPLE_SIGNING_IDENTITY not set — skipping (unsigned local build)"
  exit 0
fi

if [ ! -d "$STAGE" ]; then
  echo "presign: $STAGE missing — run stage-server.sh first" >&2
  exit 1
fi

# Same flags the ADR requires: hardened runtime + secure timestamp. The
# entitlements file is applied by Tauri to the executables it signs; plain
# dylib-style .node addons need none.
count=0
while IFS= read -r -d '' addon; do
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp "$addon"
  count=$((count + 1))
done < <(find "$STAGE" -name "*.node" -type f -print0)
echo "presign: signed $count native addon(s) in server-tree/"

# The Node sidecar ships signed by the Node.js project; re-sign with our
# identity so everything in the bundle chains to one Developer ID.
for node_bin in "$BIN_DIR"/northkeep-server-*; do
  [ -f "$node_bin" ] || continue
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp \
    --entitlements "$REPO_ROOT/apps/desktop/src-tauri/entitlements.plist" "$node_bin"
  echo "presign: signed $(basename "$node_bin")"
done

echo "presign: done (identity from APPLE_SIGNING_IDENTITY; value not shown)"
