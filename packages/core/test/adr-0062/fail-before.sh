#!/bin/sh
# Runs the ADR 0062 vitest cases against the product code of BASE (default a7eecbf^, whose
# packages/core/src equals 3202785) and then against HEAD, printing one line per test and side.
# packages/core/src must be committed; it is restored from HEAD afterwards.
set -eu
export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_NO_KEYCHAIN=1
unset DATABASE_URL CONNECTOR_KEK_PEPPER
case "$NORTHKEEP_HOME" in "$HOME/.northkeep"*|"") echo "refusing: NORTHKEEP_HOME=$NORTHKEEP_HOME" >&2; exit 2;; esac
BASE="${BASE:-a7eecbf^}"
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO"
git diff --quiet HEAD -- packages/core/src || { echo "commit packages/core/src first" >&2; exit 2; }
trap 'git checkout HEAD -- packages/core/src; rm -rf "$NORTHKEEP_HOME"' EXIT
run() {
  NO_COLOR=1 npx vitest run packages/core/test/project-compact.test.ts -t 'ADR 0062' --reporter=verbose > "$NORTHKEEP_HOME/$1.txt" 2>&1 || true
  node -e '
    const text = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
    const status = new Map(), received = new Map(); let failing = null;
    for (const line of text) {
      const row = line.match(/^\s*([\u2713\u00d7]) .*ADR 0062\) > (T\w+):/);
      if (row) status.set(row[2], row[1] === "\u2713" ? "passed" : "failed");
      const fail = line.match(/^\s*FAIL .*> (T\w+):/);
      if (fail) failing = fail[1];
      const assertion = line.match(/AssertionError: expected (\S+) to/);
      if (failing && assertion && !received.has(failing) && assertion[1].startsWith("'")) received.set(failing, ` ${assertion[1]}`);
      const plus = line.match(/^\+ (.*)$/);
      if (failing && plus && !/Received/.test(line)) received.set(failing, `${received.get(failing) ?? ""} ${plus[1].trim()}`);
    }
    for (const [name, s] of status) console.log(`${process.argv[2].padEnd(5)} ${s.padEnd(7)} ${name}${received.has(name) ? "  received:" + received.get(name).slice(0, 240) : ""}`);
  ' "$NORTHKEEP_HOME/$1.txt" "$1"
}
git checkout "$BASE" -- packages/core/src
run base
git checkout HEAD -- packages/core/src
git diff --quiet HEAD -- packages/core/src
run head
