#!/usr/bin/env bash
# Stage the production server tree for the desktop bundle (ADR 0012).
#
# Assembles apps/web + its @northkeep/* workspace packages (dist/) + their
# production node_modules into a self-contained folder the bundled Node
# sidecar can run as `node dist/server.js`. Output:
#   apps/desktop/src-tauri/server-tree/   (gitignored)
# which the bundle config maps into the app resources (macOS Resources/,
# Linux /usr/lib/<id>/).
#
# Uses `pnpm deploy` with node-linker=hoisted so the tree is REAL FILES
# (npm-style flat layout, no pnpm symlink store) — required because the
# tree gets copied into a signed .app where every Mach-O must be a plain
# file, and because native addon loaders (better-sqlite3's `bindings`,
# sodium-native's node-gyp-build) walk the real filesystem.
# Use pnpm's shared-lockfile deployment. Legacy deploy ignores the lockfile
# and can silently select dependency versions that were never tested.
# The injection setting applies only to this command; pnpm converts workspace
# links to copied packages in the deployment's frozen lockfile.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="$REPO_ROOT/apps/desktop/src-tauri/server-tree"

# Fail early if the workspace isn't built (deploy would happily copy stale dist).
if [ ! -f "$REPO_ROOT/apps/web/dist/server.js" ]; then
  echo "stage-server: apps/web/dist/server.js missing — run: pnpm build" >&2
  exit 1
fi

# `rm -rf` can lose a race with Finder/mds writing a .DS_Store into the dir
# mid-remove ("Directory not empty"); retry a few times before giving up.
for _ in 1 2 3; do rm -rf "$STAGE" 2>/dev/null && break; sleep 1; done
if [ -e "$STAGE" ]; then
  echo "stage-server: could not clear $STAGE (something is writing into it)" >&2
  exit 1
fi
if [ ! -f "$REPO_ROOT/pnpm-lock.yaml" ]; then
  echo "stage-server: pnpm-lock.yaml missing; refusing an unlocked deployment" >&2
  exit 1
fi
echo "stage-server: pnpm deploy (prod, shared lockfile, hoisted) -> $STAGE"

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

pnpm --dir "$REPO_ROOT" --filter @northkeep/web deploy --prod \
  --config.force-legacy-deploy=false --config.shared-workspace-lockfile=true \
  --config.inject-workspace-packages=true --config.node-linker=hoisted "$STAGE"

# ---- Prune what the running server never loads -----------------------------
# 1. .bin shims (symlinks; nothing in the bundle execs them, and symlinks are
#    unwelcome inside a signed Resources tree). Top-level is not enough:
#    nested copies appear too (better-sqlite3/node_modules/.bin/prebuild-install
#    on the 0.19.0 build, pnpm 11 hoisted deploy).
find "$STAGE" -type d -name '.bin' -prune -exec rm -rf {} +
# 2. Foreign-platform prebuilds — for ANY package that ships a prebuilds/ dir
#    (sodium-native, and its bare-* transitive deps). Keep only this host's
#    prebuild. On macOS every other platform's binary also fails notarization
#    (unsigned, wrong-arch Mach-O). Verified 2026-07-11: the first signed build
#    was rejected for exactly these files.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) KEEP_PREBUILD="darwin-arm64" ;;
  Linux-x86_64) KEEP_PREBUILD="linux-x64" ;;
  *)
    echo "stage-server: unsupported build host $(uname -s)/$(uname -m)" >&2
    exit 1
    ;;
esac
while IFS= read -r -d '' pbdir; do
  find "$pbdir" -mindepth 1 -maxdepth 1 -type d ! -name "$KEEP_PREBUILD" -exec rm -rf {} +
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
  "node_modules/sodium-native/prebuilds/${KEEP_PREBUILD}/sodium-native.node" \
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

# No foreign native binary may survive. On macOS anything that isn't a
# signable arm64 .node addon (presign signs those) would fail notarization
# only AFTER a multi-minute upload. On Linux the same scan keeps ELF x86-64
# .node addons and rejects Mach-O or the wrong architecture. The node SIDECAR
# lives outside $STAGE.
stray=""
while IFS= read -r -d '' f; do
  info="$(file -b "$f" 2>/dev/null)"
  case "$KEEP_PREBUILD" in
    darwin-arm64)
      [[ "$info" == *Mach-O* ]] || continue
      if [[ "$f" != *.node ]] || [[ "$info" != *arm64* ]]; then
        stray+="  ${f#"$STAGE/"}  [$info]"$'\n'
      fi
      ;;
    linux-x64)
      if [[ "$info" == *ELF* || "$info" == *Mach-O* ]]; then
        if [[ "$f" != *.node ]] || [[ "$info" != *x86-64* ]]; then
          stray+="  ${f#"$STAGE/"}  [$info]"$'\n'
        fi
      fi
      ;;
    *)
      echo "stage-server: no native check for $KEEP_PREBUILD" >&2
      exit 1
      ;;
  esac
done < <(find "$STAGE" -type f \( -name "*.node" -o -name "*.bare" -o -name "*.dylib" -o -name "*.so" -o -perm -u+x \) -print0)
if [ -n "$stray" ]; then
  echo "stage-server: unsignable/foreign Mach-O survived pruning (notarization would reject):" >&2
  printf '%s' "$stray" >&2
  echo "  → extend the prune step for the offending package." >&2
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1

echo "stage-server: staged $(du -sh "$STAGE" | cut -f1)  ($(find "$STAGE" -name '*.node' | wc -l | tr -d ' ') native addon(s))"
case "$KEEP_PREBUILD" in
  darwin-arm64) SIDECAR_NAME="northkeep-server-aarch64-apple-darwin" ;;
  linux-x64) SIDECAR_NAME="northkeep-server-x86_64-unknown-linux-gnu" ;;
esac
echo "stage-server: smoke-test it with:"
echo "  NORTHKEEP_HOME=\$(mktemp -d) NORTHKEEP_NO_KEYCHAIN=1 \\"
echo "    apps/desktop/src-tauri/binaries/${SIDECAR_NAME} \\"
echo "    $STAGE/dist/server.js"
