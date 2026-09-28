#!/bin/bash
# Mutation check for the ADR 0062 block (mutants M1 to M14 from the first code review, adr-0062-code-r1;
# X1 to X9 survivors from its recheck, adr-0062-code-r2-recheck).
# Each mutant edits packages/core/src, reruns the block and lists the tests that fail; a mutant
# no test catches fails the script. packages/core/src must be committed; it is restored after.
set -u
export NORTHKEEP_HOME="$(mktemp -d)" NORTHKEEP_NO_KEYCHAIN=1
unset DATABASE_URL CONNECTOR_KEK_PEPPER
case "$NORTHKEEP_HOME" in "$HOME/.northkeep"*|"") echo "refusing: NORTHKEEP_HOME=$NORTHKEEP_HOME" >&2; exit 2;; esac
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO"
git diff --quiet HEAD -- packages/core/src || { echo "commit packages/core/src first" >&2; exit 2; }
trap 'git checkout -q HEAD -- packages/core/src; rm -rf "$NORTHKEEP_HOME"' EXIT
V=packages/core/src/vault.ts; H=packages/core/src/project-handoff.ts
survivors=0
run() {
  git checkout -q HEAD -- packages/core/src
  perl -0pi -e "$3" "$2"
  if git diff --quiet -- packages/core/src; then echo "$1: MUTATION DID NOT APPLY"; survivors=$((survivors + 1)); return; fi
  fails=$(NO_COLOR=1 npx vitest run packages/core/test/project-compact.test.ts -t 'ADR 0062' --reporter=verbose 2>&1 | grep -oE '× .*\(ADR 0062\) > T[0-9a-z]+' | sed -E 's/.*> //' | tr '\n' ' ')
  if [ -z "$fails" ]; then survivors=$((survivors + 1)); echo "$1: SURVIVED"; else echo "$1: caught by $fails"; fi
}
run "M1 no ledger lookup"            $V 's/if\(entry\.type===.working.&&entry\.superseded_at===null&&entry\.forgotten_at===null&&parseProjectSlug\(entry\.scope\)!==null\)\{/if(false){/'
run "M2 no append in writeProject"   $V 's/built\[PROJECT_OPERATIONS_METADATA_KEY\]=\[\.\.\./void [.../'
run "M3 no malformed refusal"        $V 's/if\(malformedLedger\)throw/if(false)throw/'
run "M4 D5 ignores fingerprint"      $V 's/if\(copied\.every\(\(\{raw\}\)=>raw\.request_fingerprint===fingerprint\)\)appliedAndCompacted\(\);/appliedAndCompacted();/'
run "M5 D5 ignores forgotten"        $V 's/original\.forgotten_at!==null;/true;/'
run "M6 D5 ignores copy scope"       $V 's/if\(entry\.scope!==scope\|\|typeof raw\.result_id/if(typeof raw.result_id/'
run "M7 ledger ignores scope"        $V 's/hit\.scope===scope&&hit\.fingerprint===fingerprint/hit.fingerprint===fingerprint/'
run "M8 ledger ignores fingerprint"  $V 's/hit\.scope===scope&&hit\.fingerprint===fingerprint/hit.scope===scope/'
run "M9 cap 17"                      $H 's/PROJECT_OPERATIONS_LIMIT = 16/PROJECT_OPERATIONS_LIMIT = 17/'
run "M10 keep malformed on write"    $V 's/\[\.\.\.readProjectOperations\(\{metadata:built\}\)\.records,/[...(Array.isArray(built[PROJECT_OPERATIONS_METADATA_KEY])?built[PROJECT_OPERATIONS_METADATA_KEY]:[]),/'
run "M11 bare string not carrying"   $H 's/if\(typeof value===.string.\)return value===id;/if(typeof value==="string")return false;/'
run "M12 ledger also on superseded"  $V 's/entry\.type===.working.&&entry\.superseded_at===null&&entry\.forgotten_at===null&&parseProjectSlug/entry.type==="working"\&\&entry.forgotten_at===null\&\&parseProjectSlug/'
run "M13 D5 back to trunk throw"     $V 's/if\(copied\.length\)\{/if(copied.length){throw new ProjectHandoffError("operation_conflict","Operation receipt metadata exists without its original result.");/'
run "M14 malformed after ledger hit" $V 's/if\(malformedLedger\)throw new ProjectHandoffError\(.operation_conflict.,.Malformed project operation record..\);\n(\s*)if\(ledgerHits\.length\)\{\n(.*\n.*\n\s*\})/$1if(ledgerHits.length){\n$2\n$1if(malformedLedger)throw new ProjectHandoffError("operation_conflict","Malformed project operation record.");/'
run "X1 lookup ignores head type"      $V 's/if\(entry\.type===.working.&&entry\.superseded_at===null&&entry\.forgotten_at===null&&parseProjectSlug/if(entry.superseded_at===null\&\&entry.forgotten_at===null\&\&parseProjectSlug/'
run "X2 cap keeps oldest 16"           $V 's/\.slice\(-PROJECT_OPERATIONS_LIMIT\)/.slice(0,PROJECT_OPERATIONS_LIMIT)/'
run "X3 saved_at not head time"        $V 's/saved_at:now\}\]/saved_at:new Date(0).toISOString()}]/'
run "X4 record accepts extra keys"     $H 's/keys\.length===OPERATION_RECORD_KEYS\.length&&//'
run "X5 ledger stale without document" $V 's/(send any new save with a new operation id\.).,current\);\};/$1\x27,undefined);};/'
run "X6 D5 ignores original scope"     $V 's/original\.scope===scope&&//'
run "X7 saved_at not validated"        $H 's/&&typeof r\.saved_at===.string.&&Number\.isFinite\(Date\.parse\(r\.saved_at\)\)//'
run "X8 fingerprint any hex length"    $H 's/\/\^\[0-9a-f\]\{64\}\$\/\.test\(r\.request_fingerprint\)/\/^[0-9a-f]+\$\/.test(r.request_fingerprint)/'
run "X9 ledger hits every -> some"     $V 's/ledgerHits\.every\(/ledgerHits.some(/'
git checkout -q HEAD -- packages/core/src
git diff --quiet -- packages/core/src && echo "restored clean"
echo "survivors: $survivors"
[ "$survivors" -eq 0 ]
