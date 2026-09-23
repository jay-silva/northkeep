#!/usr/bin/env bash
# ADR 0054 (M-D1) owner acceptance: the project board. One step per call, run
# from the repository root after `pnpm -r build`. Every step uses a throwaway
# vault under /tmp/nk-0054-acceptance and never opens ~/.northkeep. Step 1
# imports a COPY of the command repo's projects (or NK_0054_SOURCE, a folder of
# <slug>.md files) and deletes the copy. Steps 6 and 7 use a disposable MCP
# client (scripts/adr-0054-mcp.mjs) that refuses any other home.
set -u
L=/tmp/nk-0054-acceptance
SRC="${NK_0054_SOURCE:-$HOME/Claude/Projects/Command Repo/projects}"
CLI="$(pwd)/packages/cli/dist/index.js"
MCP="$(pwd)/scripts/adr-0054-mcp.mjs"
[ -f "$CLI" ] || { echo "Run from the NorthKeep repository root after pnpm -r build."; exit 2; }
nk() { node "$CLI" "$@"; }
app() { node "$MCP" "$@"; }
export NORTHKEEP_HOME=$L/home NORTHKEEP_PASSPHRASE='adr 0054 acceptance passphrase' NORTHKEEP_NO_KEYCHAIN=1
unset NORTHKEEP_SCOPES NORTHKEEP_REDACT_TIER NORTHKEEP_MASTER_KEY
section() { nk projects board "$@" | awk -v h="$SECTION" 'index($0, h" (")==1 {on=1; print; next} on && /^$/ {exit} on {print}'; }
case "${1:-}" in
setup)
  rm -rf $L; mkdir -p $L/home
  nk init 2>&1 | head -1
  nk projects update demo --what-why "A demo project." --status "Starting." | tail -1
  nk projects update other --what-why "Another project." --status "Fine." | tail -1 ;;
1) rm -rf $L/src; cp -R "$SRC" $L/src || exit 1
   nk projects import --from $L/src --write | tail -2
   before=$(pgrep -f ollama | wc -l | tr -d ' ')
   nk projects board | grep -E '^(Project board|Done rule|Stale|Dated items|Open sessions|Drafts|Needs repair)'
   after=$(pgrep -f ollama | wc -l | tr -d ' ')
   echo "ollama processes before: $before, after: $after"
   rm -rf $L/src ;;
2) echo "board --json bytes: $(nk projects board --json | wc -c | tr -d ' ') (ceiling 131072)" ;;
3) echo "--stale-days 1: $(nk projects board --stale-days 1 --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);console.log(b.stale.total+" stale, "+b.stale.rows.filter(r=>r.activity_source==="last log entry").length+" of the shown rows by last log entry")})')"
   SECTION=Stale section --stale-days 1 | head -4
   echo "--stale-days 3650:"; SECTION=Stale section --stale-days 3650 ;;
4) f=$NORTHKEEP_HOME/vault.nkv; before=$(shasum -a 256 "$f" | cut -d' ' -f1)
   nk projects board >/dev/null; nk projects board --json >/dev/null
   after=$(shasum -a 256 "$f" | cut -d' ' -f1)
   [ "$before" = "$after" ] && echo "vault unchanged: $before" || echo "VAULT CHANGED: $before -> $after" ;;
5) nk projects update demo --next-actions "- 2026-10-15 renew the Dartmouth listing" | tail -1
   nk projects update other --open-questions "- 2026-10-03 which inspector do we hire?" | tail -1
   SECTION="Dated items" section | grep -E ' (demo|other) ' ;;
6) echo "before: $(SECTION="Open sessions" section | grep -c ' demo ') open session(s) for demo"
   app read demo
   echo "after the read: $(SECTION="Open sessions" section | grep -c ' demo ') open session(s) for demo"
   SECTION="Open sessions" section | grep ' demo '
   app board
   echo "after the MCP board: $(SECTION="Open sessions" section | grep -c ' demo ') open session(s) for demo" ;;
7) app draft drafty; echo "Drafts: $(SECTION=Drafts section | grep -c ' drafty ') row(s) for drafty"
   app wrap drafty; echo "Drafts after the wrap: $(SECTION=Drafts section | grep -c ' drafty ') row(s) for drafty" ;;
8) nk projects update hostile --what-why "Hostile text test." --status "$(printf 'Red \033[31mALERT\033[0m here\342\200\250second half')" | tail -1
   row=$(SECTION=Stale section --stale-days 0 | grep ' hostile ')
   echo "row: $row"
   echo "escape bytes in the row: $(printf '%s' "$row" | LC_ALL=C grep -c "$(printf '\033')")"
   echo "line separators in the row: $(printf '%s' "$row" | LC_ALL=C grep -c "$(printf '\342\200\250')")" ;;
9) nk remember "$(printf '## Current Status\n\nOne.\n\n## Current Status\n\nTwo.')" --scope project:broken --type working | cut -c1-40
   SECTION="Needs repair" section
   nk projects board | grep -E '^(Stale|Dated items|Open sessions|Drafts|Needs repair) ' ;;
10) mon=$(node -e 'const d=new Date(Date.now()-3*86400000);console.log(d.toLocaleString("en-US",{month:"short",timeZone:"UTC"})+" "+d.getUTCDate()+" "+d.toISOString().slice(0,10))')
   words=${mon% *}; iso=${mon##* }
   nk projects update other --next-actions "- $words file the renewal" | tail -1
   echo "expected date: $iso"
   SECTION="Dated items" section | grep "file the renewal" ;;
clean) rm -rf $L; echo "removed $L" ;;
*) echo "usage: bash scripts/adr-0054-acceptance.sh setup|1|2|3|4|5|6|7|8|9|10|clean"; exit 2 ;;
esac
