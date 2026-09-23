#!/usr/bin/env bash
# ADR 0053 (M-A1) owner acceptance: one step per call, run from the repository
# root after `pnpm -r build`. Every step uses a throwaway vault and mirror under
# /tmp/nk-0053-acceptance and never opens ~/.northkeep. Step 7 reads a COPY of
# the command repo and deletes the copy when done.
set -u
L=/tmp/nk-0053-acceptance; R=$L/mirror
CLI="$(pwd)/packages/cli/dist/index.js"
[ -f "$CLI" ] || { echo "Run from the NorthKeep repository root after pnpm -r build."; exit 2; }
nk() { node "$CLI" "$@"; }
export NORTHKEEP_HOME=$L/home NORTHKEEP_PASSPHRASE='adr 0053 acceptance passphrase' NORTHKEEP_NO_KEYCHAIN=1
case "${1:-}" in
setup)
  rm -rf $L; mkdir -p $L/home $R
  git -C $R init -q && git -C $R config user.email you@example.com && git -C $R config user.name Jay
  nk init 2>&1 | head -1
  nk projects update demo --what-why "A demo project." --status "Starting." --log "Created." | tail -1
  nk projects update other --what-why "Another project." --status "Fine." | tail -1 ;;
1) nk projects export --repo $R; echo "exit $?"; ls -A $R; echo "commits: $(git -C $R log --oneline | wc -l | tr -d ' ')"
   mkdir -p $L/busy && git -C $L/busy init -q && touch $L/busy/x
   NORTHKEEP_HOME=$L/home2 nk init >/dev/null 2>&1; NORTHKEEP_HOME=$L/home2 nk projects export --repo $L/busy; echo "non-empty folder exit $?" ;;
2) rm -rf $L/a; cp -R $R/projects $L/a; nk projects export; diff -r $L/a $R/projects && echo "diff silent"
   echo "commits: $(git -C $R log --oneline | wc -l | tr -d ' ')"; echo "git status: [$(git -C $R status --short)]" ;;
3) nk projects export --verify; echo "exit $?" ;;
4) echo note >> $R/projects/demo.md; nk projects export --verify; echo "verify exit $?"
   nk projects update other --status "Changed while demo was hand-edited." | tail -1
   nk projects export; echo "export exit $?"; echo "last line of demo.md: $(tail -1 $R/projects/demo.md)" ;;
5) git -C $R checkout -- projects/demo.md; nk projects update other --status "Changed again." | tail -1
   nk projects export --status; nk projects export; echo "export exit $?" ;;
6) bash scripts/adr-0053-canary.sh | tail -3 ;;
7) rm -rf $L/cr; cp -R "$HOME/Claude/Projects/Command Repo" $L/cr
   before=$(cd $L/cr/projects && shasum -a 256 *.md | shasum -a 256)
   nk projects import --from $L/cr/projects | tail -3; echo "import exit $?"
   after=$(cd $L/cr/projects && shasum -a 256 *.md | shasum -a 256)
   [ "$before" = "$after" ] && echo "source files unchanged by the import" || echo "SOURCE FILES CHANGED"
   rm -rf $L/cr ;;
8) git init -q --bare $L/bare.git; git -C $R remote add origin $L/bare.git
   nk projects update demo --status "With a remote." | tail -1; nk projects export
   nk projects export --status | grep -i remote; echo "commits in the remote: $(git -C $L/bare.git rev-list --all | wc -l | tr -d ' ')" ;;
9) nk projects update demo --status "Crash test." | tail -1
   NORTHKEEP_EXPORT_CRASH_WRITE=1 nk projects export; echo "crashed export exit $?"; ls $R/projects
   nk projects export; echo "next export exit $?"; ls $R/projects; nk projects export --verify | tail -1 ;;
10) nk projects update gone --what-why "Exported then deleted." --status "Here." | tail -1; nk projects export | tail -1
   nk projects delete gone --yes | head -1; nk projects export | tail -2; ls $R/projects ;;
clean) rm -rf $L; echo "removed $L" ;;
*) echo "usage: bash scripts/adr-0053-acceptance.sh setup|1|2|3|4|5|6|7|8|9|10|clean"; exit 2 ;;
esac
