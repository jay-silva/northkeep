#!/bin/sh
# Regenerates packages/core/test/fixtures/v0220-carry-forward.{nkv,json} with the released
# v0.22.0 core. OLD=<existing built v0.22.0 checkout> skips the worktree build.
set -eu
export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_NO_KEYCHAIN=1
unset DATABASE_URL CONNECTOR_KEK_PEPPER
case "$NORTHKEEP_HOME" in "$HOME/.northkeep"*|"") echo "refusing: NORTHKEEP_HOME=$NORTHKEEP_HOME" >&2; exit 2;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
if [ -z "${OLD:-}" ]; then
  OLD="$(mktemp -d)/nk-0220"
  trap 'git -C "$REPO" worktree remove --force "$OLD"; rm -rf "$NORTHKEEP_HOME"' EXIT
  git -C "$REPO" worktree add --detach "$OLD" v0.22.0
  (cd "$OLD" && pnpm install --offline --frozen-lockfile && pnpm -r build) >/dev/null
else
  trap 'rm -rf "$NORTHKEEP_HOME"' EXIT
fi
test "$(git -C "$OLD" rev-parse HEAD)" = "$(git -C "$REPO" rev-parse 'v0.22.0^{commit}')" || { echo "OLD is not v0.22.0" >&2; exit 2; }
OLD="$OLD" OUT="$REPO/packages/core/test/fixtures" node "$HERE/make-v0220-fixture.mjs"
