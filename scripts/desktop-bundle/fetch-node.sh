#!/usr/bin/env bash
# Fetch the pinned Node.js runtime for the desktop sidecar (ADR 0012).
#
# Downloads the official nodejs.org tarball for the pinned version, verifies
# it against the release SHASUMS256.txt, extracts just the `node` binary, and
# places it where tauri.conf expects an externalBin:
#   apps/desktop/src-tauri/binaries/northkeep-server-<target-triple>
#
# Downloads are cached in apps/desktop/.node-cache/ (gitignored); re-runs are
# offline once the tarball is cached. The checksum is re-verified on every run.
#
# This is the ONE place the Node version is pinned. Bump it here on Node
# security releases (see ADR 0012 "we become a runtime redistributor").
set -euo pipefail

NODE_VERSION="24.14.0"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE_DIR="$REPO_ROOT/apps/desktop/.node-cache"
BIN_DIR="$REPO_ROOT/apps/desktop/src-tauri/binaries"

# Map this machine to Node's dist name and Rust's target triple.
# aarch64-apple-darwin only for the first release (ADR 0012, Decision 3).
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    NODE_PLATFORM="darwin-arm64"
    TARGET_TRIPLE="aarch64-apple-darwin"
    ;;
  *)
    echo "fetch-node: unsupported build host $(uname -s)/$(uname -m) — ADR 0012 targets aarch64-apple-darwin only" >&2
    exit 1
    ;;
esac

DIST_NAME="node-v${NODE_VERSION}-${NODE_PLATFORM}"
TARBALL="${DIST_NAME}.tar.gz"
BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
SHASUMS="SHASUMS256-v${NODE_VERSION}.txt"
DEST="$BIN_DIR/northkeep-server-${TARGET_TRIPLE}"

mkdir -p "$CACHE_DIR" "$BIN_DIR"
cd "$CACHE_DIR"

if [ ! -f "$SHASUMS" ]; then
  echo "fetch-node: downloading SHASUMS256.txt for v${NODE_VERSION}"
  curl -fsSL -o "$SHASUMS.tmp" "$BASE_URL/SHASUMS256.txt"
  mv "$SHASUMS.tmp" "$SHASUMS"
fi

if [ ! -f "$TARBALL" ]; then
  echo "fetch-node: downloading $TARBALL from nodejs.org (build-time only; nothing downloads at runtime)"
  curl -fSL -o "$TARBALL.tmp" "$BASE_URL/$TARBALL"
  mv "$TARBALL.tmp" "$TARBALL"
else
  echo "fetch-node: using cached $TARBALL"
fi

# Verify against the published checksum on every run (cached or not).
# RESIDUAL (documented in KNOWN-LIMITS): SHASUMS256.txt is fetched over HTTPS
# from the same host as the tarball and is NOT GPG-verified against Node's
# release keys — so this stops accidental corruption and naive MITM, but not a
# compromise of the nodejs.org dist server serving a matching bad pair. Add
# `gpg --verify SHASUMS256.txt.sig` before wide distribution.
grep " ${TARBALL}\$" "$SHASUMS" | shasum -a 256 -c - >/dev/null
echo "fetch-node: SHA-256 verified against published SHASUMS256.txt (see KNOWN-LIMITS re: GPG)"

# Extract only the node binary, straight to the externalBin location.
# (-O loses the exec bit, so restore it.)
tar -xzf "$TARBALL" -O "${DIST_NAME}/bin/node" > "$DEST.tmp"
chmod 755 "$DEST.tmp"
mv "$DEST.tmp" "$DEST"

"$DEST" --version >/dev/null # sanity: it runs on this machine
echo "fetch-node: staged $DEST ($("$DEST" --version))"
