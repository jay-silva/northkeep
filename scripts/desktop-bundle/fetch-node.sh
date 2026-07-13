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

# --- Integrity: SHA-256, then a GPG signature over the SHASUMS file itself. ---

# 1. SHA-256: the tarball matches the published checksum on every run (cached or
#    not). Catches corruption and naive tampering — but not a SHASUMS file that
#    was itself swapped for a matching bad pair.
grep " ${TARBALL}\$" "$SHASUMS" | shasum -a 256 -c - >/dev/null
echo "fetch-node: SHA-256 verified against SHASUMS256.txt"

# 2. GPG: SHASUMS256.txt is signed by a Node.js release key. This closes the gap
#    above — a compromised dist server can't forge a matching bad pair without a
#    release private key. Trust comes from PINNED FINGERPRINTS (a hostile
#    keyserver can't substitute a key), not the web of trust, so gpg's
#    "not certified" warning on a good signature is expected. Fail-closed on a
#    real (signed) release build; on a plain source build without gpg, warn
#    loudly and fall back to SHA-256 only.
#
# CROSS-CHECK these against the authoritative list at
# https://github.com/nodejs/node#release-keys and add fingerprints on key
# rotation — verification fails closed if the actual signer isn't listed.
NODE_RELEASE_KEYS=(
  "4ED778F539E3634C779C87C6D7062848A1AB005C"  # Beth Griggs
  "141F07595B7B3FFE74309A937405533BE57C7D57"  # Bryan English
  "74F12602B6F1C4E913FAA37AD3A89613643B6201"  # Danielle Adams
  "8FCCA13FEF1D0C2E91008E09770F7A9A5AE15600"  # Michaël Zasso
  "C4F0DFFF4E8C1A8236409D08E73BC641CC11F4C8"  # Myles Borins
  "890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4"  # RafaelGSS
  "C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C"  # Richard Lau
  "108F52B48DB57BB0CC439B2997B01419BD92F80A"  # Ruy Adorno
  "A363A499291CBBC940DD62E41F10027AF002F8B0"  # Ulises Gascón
  "C0D6248439F1D5604AAFFB4021D900FFDB233756"  # Antoine du Hamel
  "1C050899334244A8AF75E53792EF661D867B9DFA"  # Rich Trott
)

# A signed release build (Apple identity present) MUST verify the signature; a
# plain `pnpm build` from source may not have gpg installed.
REQUIRE_GPG=0
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] || [ "${NORTHKEEP_REQUIRE_GPG:-0}" = "1" ]; then
  REQUIRE_GPG=1
fi

if ! command -v gpg >/dev/null 2>&1; then
  if [ "$REQUIRE_GPG" = "1" ]; then
    echo "fetch-node: FATAL — this is a release build but gpg is not installed." >&2
    echo "  Install it so the Node signature can be verified: brew install gnupg" >&2
    exit 1
  fi
  echo "fetch-node: WARNING — gpg not installed; relying on SHA-256 ONLY (no signature check)." >&2
  echo "  For a distributable build run: brew install gnupg   (then rebuild)." >&2
else
  if [ ! -f "$SHASUMS.sig" ]; then
    curl -fsSL -o "$SHASUMS.sig.tmp" "$BASE_URL/SHASUMS256.txt.sig"
    mv "$SHASUMS.sig.tmp" "$SHASUMS.sig"
  fi
  # Dedicated, reproducible keyring under the cache — never touches your keyring.
  GNUPGHOME="$CACHE_DIR/gnupg"; export GNUPGHOME
  mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
  gpg_err="$(mktemp)"
  _nk_verify() { gpg --batch --verify "$SHASUMS.sig" "$SHASUMS" 2>"$gpg_err"; }
  # Try verify first (offline-friendly on cached re-runs); import keys only if
  # the key isn't already in the local keyring, then retry once.
  if ! _nk_verify; then
    echo "fetch-node: importing pinned Node.js release keys"
    gpg --batch --keyserver hkps://keys.openpgp.org --recv-keys "${NODE_RELEASE_KEYS[@]}" 2>/dev/null \
      || gpg --batch --keyserver hkps://keyserver.ubuntu.com --recv-keys "${NODE_RELEASE_KEYS[@]}" 2>/dev/null \
      || true
    _nk_verify || {
      echo "fetch-node: FATAL — GPG verification of SHASUMS256.txt FAILED." >&2
      echo "  Either a keyserver was unreachable, or the signer is a newer Node" >&2
      echo "  release key not yet in NODE_RELEASE_KEYS. gpg said:" >&2
      sed 's/^/    /' "$gpg_err" >&2
      echo "  Cross-check the signer at https://github.com/nodejs/node#release-keys" >&2
      echo "  and add its fingerprint to fetch-node.sh, then rebuild." >&2
      rm -f "$gpg_err"
      exit 1
    }
  fi
  signer="$(grep -oiE 'key [0-9A-F]+' "$gpg_err" | head -1)"
  rm -f "$gpg_err"
  echo "fetch-node: GPG signature verified — SHASUMS256.txt signed by a pinned Node.js release ${signer:-key}"
fi

# Extract only the node binary, straight to the externalBin location.
# (-O loses the exec bit, so restore it.)
tar -xzf "$TARBALL" -O "${DIST_NAME}/bin/node" > "$DEST.tmp"
chmod 755 "$DEST.tmp"
mv "$DEST.tmp" "$DEST"

"$DEST" --version >/dev/null # sanity: it runs on this machine
echo "fetch-node: staged $DEST ($("$DEST" --version))"
