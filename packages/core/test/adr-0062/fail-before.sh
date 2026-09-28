#!/bin/sh
# Runs the ADR 0062 vitest cases against the product code of BASE (default a7eecbf^, whose
# packages/core/src equals 3202785) and then against HEAD, printing one line per test and side.
# packages/core/src must be committed; it is restored from HEAD afterwards.
set -eu
export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_NO_KEYCHAIN=1
unset DATABASE_URL CONNECTOR_KEK_PEPPER
case "$NORTHKEEP_HOME" in "$HOME/.northkeep"*|"") echo "refusing: NORTHKEEP_HOME=$NORTHKEEP_HOME" >&2; exit 2;; esac
BASE="${BASE:-a7eecbf^}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
cd "$REPO"
git diff --quiet HEAD -- packages/core/src || { echo "commit packages/core/src first" >&2; exit 2; }
trap 'git checkout HEAD -- packages/core/src; rm -rf "$NORTHKEEP_HOME"' EXIT
run() {
  NO_COLOR=1 npx vitest run packages/core/test/project-compact.test.ts -t 'ADR 0062' --reporter=verbose > "$NORTHKEEP_HOME/$1.txt" 2>&1 || true
  node "$HERE/vitest-report.mjs" "$NORTHKEEP_HOME/$1.txt" "$1"
}
git checkout "$BASE" -- packages/core/src
run base
git checkout HEAD -- packages/core/src
git diff --quiet HEAD -- packages/core/src
run head
