#!/usr/bin/env bash
# ADR 0063 (sync guardrails) owner acceptance, design section 9. One step per
# call, from the repository root after `pnpm -r build`. Everything runs on
# this Mac: a throwaway vault under /tmp/nk-0063-acceptance, a local sync
# server, and a local Cloud Connect connector on the real connector SQL over
# PGlite (scripts/adr-0063-servers.mjs). Nothing opens ~/.northkeep and
# nothing reaches the internet. `setup` prints the environment the commands
# between steps need. `all` runs the whole sequence unattended.
set -u
L=/tmp/nk-0063-acceptance
ROOT="$(pwd)"
CLI="$ROOT/packages/cli/dist/index.js"
[ -f "$CLI" ] && [ -f "$ROOT/apps/connector-server/dist/create-server.js" ] || { echo "Run from the NorthKeep repository root after pnpm -r build."; exit 2; }
if [ -n "${NORTHKEEP_HOME:-}" ] && [ "$NORTHKEEP_HOME" != "$L/home" ]; then
  echo "Refusing: NORTHKEEP_HOME is $NORTHKEEP_HOME. This script only uses $L/home."; exit 2
fi
export NORTHKEEP_HOME=$L/home NORTHKEEP_PASSPHRASE='adr 0063 acceptance passphrase' NORTHKEEP_NO_KEYCHAIN=1
unset NORTHKEEP_SCOPES NORTHKEEP_MASTER_KEY NORTHKEEP_CLAUDE_RULES_DIR NORTHKEEP_ASSUME_YES
nk() { node "$CLI" "$@"; }
nkb() { NORTHKEEP_HOME=$L/home-b node "$CLI" "$@"; }
cloud() { node "$ROOT/scripts/adr-0063-cloud.mjs" "$L" "$@"; }
FAILED=0
check() { if [ "$1" = ok ]; then echo "  ok: $2"; else echo "  FAIL: $2"; FAILED=1; fi; }
has() { if printf '%s' "$1" | grep -qF -- "$2"; then echo ok; else echo no; fi; }
head_status() { nk list --scope project:demo --type working | awk '/^## Current Status/{getline; getline; print; exit}'; }
head_rev() { nk projects history demo | sed -n 's/^Project demo, current version \([^ ]*\) .*/\1/p'; }
alive() { [ -f $L/servers.json ] && kill -0 "$(node -e "console.log(require('$L/servers.json').pid)")" 2>/dev/null; }
envline() { echo "export NORTHKEEP_HOME=$L/home NORTHKEEP_PASSPHRASE='adr 0063 acceptance passphrase' NORTHKEEP_NO_KEYCHAIN=1"; }

step_setup() {
  if alive; then echo "The acceptance servers are already running. Run: bash scripts/adr-0063-acceptance.sh cleanup"; exit 2; fi
  rm -rf $L; mkdir -p $L/home
  node "$ROOT/scripts/adr-0063-servers.mjs" $L > $L/servers.log 2>&1 &
  for _ in $(seq 1 40); do [ -f $L/servers.json ] && break; sleep 0.25; done
  [ -f $L/servers.json ] || { echo "The local servers did not start:"; cat $L/servers.log; exit 1; }
  S=$(node -e "console.log(require('$L/servers.json').sync)")
  C=$(node -e "console.log(require('$L/servers.json').connector)")
  nk init >/dev/null 2>&1 || { echo "init failed"; exit 1; }
  nk sync config --server "$S" | head -1
  nk sync push
  nk share server "$C" | head -1
  nk projects update demo --what-why "A demo project for ADR 0063." --status "R1: the first version." 2>&1 | tail -1
  nk share add project:demo --yes | head -1
  nk remember "A note both Macs have." --scope notes --type semantic 2>&1 | tail -1
  code=$(nk share code | sed -n 's/^Pairing code: //p')
  cloud connect "$code"
  cloud get demo
  check "$(has "$(cat $NORTHKEEP_HOME/sync.json $NORTHKEEP_HOME/connector.json)" '127.0.0.1')" "sync.json and connector.json point at this Mac (127.0.0.1)"
  check "$(has "$(cloud get demo)" 'R1: the first version.')" "the cloud app reads R1"
  echo; echo "For the commands between steps, paste this into the same terminal first:"; envline
}

step_1() {
  echo "A connected app edits the project, then this Mac saves a newer version (the 2026-09-30 incident):"
  cloud update demo "CLOUD: written by a connected app."
  nk projects update demo --status "R2: saved on this Mac after the cloud edit." 2>&1 | tail -1
  head_rev > $L/r2.txt
  check "$(has "$(head_status)" 'R2: saved on this Mac')" "this Mac's head is R2 ($(cat $L/r2.txt))"
  echo; echo "Next: node packages/cli/dist/index.js share sync"
  echo "Expect a conflict for demo that is not applied, and no question, because nothing would be replaced."
}

step_2() {
  echo "This Mac's project after Sync now:"
  echo "  head $(head_rev): $(head_status)"
  check "$(has "$(head_status)" 'R2: saved on this Mac')" "the cloud edit did not replace the newer local save"
  conflicts=$(nk share conflicts)
  echo "$conflicts" | sed 's/^/  /'
  check "$(has "$conflicts" 'demo')" "the cloud version waits as a conflict"
  echo; echo "Next: node packages/cli/dist/index.js share resolve demo --take-theirs"
}

step_3() {
  echo "After take theirs:"
  echo "  head $(head_rev): $(head_status)"
  head_rev > $L/r-cloud.txt
  check "$(has "$(head_status)" 'CLOUD: written by a connected app.')" "the head is the cloud text"
  check "$(has "$(nk projects history demo)" "$(cat $L/r2.txt)")" "history still holds R2 ($(cat $L/r2.txt))"
  echo; echo "Next: node packages/cli/dist/index.js projects restore demo $(cat $L/r2.txt) --yes"
}

step_4() {
  echo "After restore:"
  echo "  head $(head_rev): $(head_status)"
  check "$(has "$(head_status)" 'R2: saved on this Mac')" "the head is R2's text again, as a new version"
  stale=$(nk projects restore demo "$(cat $L/r2.txt)" --expected-revision "$(cat $L/r-cloud.txt)" --yes 2>&1)
  echo "  a restore pinned to the old head says: $(echo "$stale" | head -1)"
  check "$(has "$(head_status)" 'R2: saved on this Mac')" "the stale restore changed nothing"
  check "$(has "$stale" 'changed')" "the stale restore was refused"
}

step_5() {
  echo "A cloud write with no recorded base (the shape every row written before ADR 0063 has):"
  out=$(cloud update demo "LEGACY: a cloud write from before ADR 0063.")
  echo "  $out"
  id=$(printf '%s' "$out" | sed -n 's/^Cloud app wrote revision \([^ ]*\) .*/\1/p')
  cloud legacy "$id" | sed 's/^/  /'
  before=$(head_rev)
  sync=$(nk share sync --yes 2>&1)
  echo "$sync" | sed 's/^/  /'
  check "$(has "$sync" 'does not say which copy it started from')" "the row is held as a conflict: it records no base"
  check "$( [ "$(head_rev)" = "$before" ] && echo ok || echo no)" "the head did not change, even with --yes"
  check "$(has "$(head_status)" 'R2: saved on this Mac')" "the legacy text was never applied"
}

step_6() {
  echo "Two Macs change the vault at once, then this Mac pulls:"
  mkdir -p $L/home-b; cp $NORTHKEEP_HOME/device.secret $L/home-b/
  S=$(node -e "console.log(require('$L/servers.json').sync)")
  nkb sync config --server "$S" >/dev/null
  nkb sync pull --yes | head -1
  nkb remember "Written on the other Mac." --scope notes --type semantic 2>&1 | tail -1
  nk remember "Only on this Mac." --scope notes --type semantic >/dev/null 2>&1
  note=$(nk list --scope notes | awk '/A note both Macs have/{getline; print $2; exit}')
  nk forget "$note" >/dev/null 2>&1
  nk sync status | sed 's/^/  /' 
  f=$NORTHKEEP_HOME/vault.nkv; before=$(shasum -a 256 "$f" | cut -d' ' -f1)
  report=$(nk sync pull < /dev/null 2>&1); code=$?
  echo "$report" | sed 's/^/  /'
  after=$(shasum -a 256 "$f" | cut -d' ' -f1)
  check "$(has "$report" 'Only on this Mac.')" "the report names the memory only this Mac has"
  check "$(has "$report" 'back')" "the report names the delete the pull would undo"
  check "$( [ $code -ne 0 ] && echo ok || echo no)" "with no terminal to ask on, the pull stopped (exit $code)"
  check "$( [ "$before" = "$after" ] && echo ok || echo no)" "this Mac's vault file is unchanged"
}

step_cleanup() {
  if alive; then kill "$(node -e "console.log(require('$L/servers.json').pid)")"; fi
  rm -rf $L; echo "Stopped the local servers and removed $L."
}

case "${1:-}" in
setup) step_setup ;;
1) step_1 ;;
2) step_2 ;;
3) step_3 ;;
4) step_4 ;;
5) step_5 ;;
6) step_6 ;;
cleanup) step_cleanup ;;
all)
  step_setup; step_1
  echo "\$ northkeep share sync"; nk share sync < /dev/null 2>&1 | sed 's/^/  /'
  step_2
  echo "\$ northkeep share resolve demo --take-theirs"; nk share resolve demo --take-theirs 2>&1 | sed 's/^/  /'
  step_3
  echo "\$ northkeep projects restore demo $(cat $L/r2.txt) --yes"; nk projects restore demo "$(cat $L/r2.txt)" --yes 2>&1 | sed 's/^/  /'
  step_4; step_5; step_6
  result=$FAILED; step_cleanup
  [ $result -eq 0 ] && echo "ADR 0063 acceptance: every check passed." || echo "ADR 0063 acceptance: a check FAILED (see above)."
  exit $result ;;
*) echo "usage: bash scripts/adr-0063-acceptance.sh setup|1|2|3|4|5|6|cleanup|all"; exit 2 ;;
esac
exit $FAILED
