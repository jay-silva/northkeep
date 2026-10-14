#!/usr/bin/env bash
# ADR 0065 K1 owner acceptance: project milestones. One step per call, run from
# the repository root after `pnpm -r build`. Every step uses a throwaway vault
# under /tmp/nk-k1-acceptance and never opens ~/.northkeep. The AI app is a
# disposable MCP client (scripts/milestones-k1-mcp.mjs) that refuses any other home.
set -u
L=/tmp/nk-k1-acceptance
CLI="$(pwd)/packages/cli/dist/index.js"
MCP="$(pwd)/scripts/milestones-k1-mcp.mjs"
[ -f "$CLI" ] || { echo "Run from the NorthKeep repository root after pnpm -r build."; exit 2; }
nk() { node "$CLI" "$@"; }
app() { node "$MCP" "$@"; }
export NORTHKEEP_HOME=$L/home NORTHKEEP_PASSPHRASE='k1 acceptance passphrase' NORTHKEEP_NO_KEYCHAIN=1
unset NORTHKEEP_SCOPES NORTHKEEP_REDACT_TIER NORTHKEEP_MASTER_KEY NORTHKEEP_ASSUME_YES
case "${1:-}" in
setup)
  rm -rf $L; mkdir -p $L/home
  nk init 2>&1 | head -1 ;;
1) nk projects update plain --what-why "A project made in Terminal." --status "Starting." | tail -1
   nk projects update titled --title Files --status "Starting." 2>&1 | tail -1 ;;
2) app create rental
   nk projects milestones rental ;;
3) app report rental
   nk projects milestones rental ;;
4) app refusals rental ;;
5) app converse rental ;;
6) echo yes | nk projects pass rental M1 2>&1 | tail -1
   NORTHKEEP_ASSUME_YES=1 nk projects pass rental M1 --yes < /dev/null 2>&1 | tail -1
   nk projects milestones rental | head -2 ;;
7) nk projects pass rental M1
   nk projects milestones rental | head -2 ;;
clean) rm -rf $L; echo "removed $L" ;;
*) echo "usage: bash scripts/milestones-k1-acceptance.sh setup|1|2|3|4|5|6|7|clean"; exit 2 ;;
esac
