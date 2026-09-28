#!/bin/sh
# ADR 0062 perf gates (the ADR's Perf gate section). Needs this checkout built (pnpm -r build).
# Builds v0.22.0 in a temp git worktree unless OLD=<built v0.22.0 checkout> is given.
set -eu
export NORTHKEEP_NO_KEYCHAIN=1
unset DATABASE_URL CONNECTOR_KEK_PEPPER
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
if [ -z "${OLD:-}" ]; then
  OLD="$(mktemp -d)/nk-0220"
  trap 'git -C "$REPO" worktree remove --force "$OLD"' EXIT
  git -C "$REPO" worktree add --detach "$OLD" v0.22.0
  (cd "$OLD" && pnpm install --offline --frozen-lockfile && pnpm -r build) >/dev/null
fi
test "$(git -C "$OLD" rev-parse HEAD)" = "$(git -C "$REPO" rev-parse 'v0.22.0^{commit}')" || { echo "OLD is not v0.22.0" >&2; exit 2; }
run() {
  NORTHKEEP_HOME="$(mktemp -d)"; export NORTHKEEP_HOME
  case "$NORTHKEEP_HOME" in "$HOME/.northkeep"*|"") echo "refusing: NORTHKEEP_HOME=$NORTHKEEP_HOME" >&2; exit 2;; esac
  NEW="$REPO" OLD="$OLD" MODE="$1" MEMS="$2" node "$HERE/perf.mjs"
  rm -rf "$NORTHKEEP_HOME"
}
for mems in 0 1000 3000; do run shared "$mems"; done
for mems in 0 1000 3000; do for n in 1 2 3; do run separate "$mems"; done; done
