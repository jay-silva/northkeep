#!/usr/bin/env bash
# Probe the hosted sync server and connector server and fail loudly if either
# is not answering the way healthy code answers. Runs from GitHub Actions every
# 15 minutes and after each deploy (.github/workflows/hosted-probe.yml); run it
# by hand any time:
#
#   scripts/probe-hosted.sh
#   SYNC_URL=https://... CONNECTOR_URL=https://... scripts/probe-hosted.sh
#
# Why exact status codes and not "anything but 500": on 2026-09-03 the sync
# server had been returning FUNCTION_INVOCATION_FAILED on EVERY route for six
# days before a phone banner surfaced it. A probe that only checks "the host
# responds" would have passed the whole time. Each check below needs the real
# request code to run, and the DB-touching ones need Neon to answer too.
#
# The probe token is a throwaway string that is long enough to pass the
# "malformed token" check and is not on any allowlist, so it never reads or
# writes anything. No credentials are needed and none are used. Four requests
# per run is far under the per-account window (120 per 5 minutes).
set -uo pipefail

SYNC_URL="${SYNC_URL:-https://northkeep-sync-server.vercel.app}"
CONNECTOR_URL="${CONNECTOR_URL:-https://northkeep-connector-server.vercel.app}"
PROBE_TOKEN="probe-token-not-a-real-account-0000"
CURL=(curl --silent --show-error --max-time 25 --retry 2 --retry-connrefused)

failures=0
pass() { printf '  ok    %-40s %s\n' "$1" "$2"; }
fail() { printf '  FAIL  %-40s %s\n' "$1" "$2"; failures=$((failures + 1)); }

# check NAME EXPECTED_STATUS BODY_MUST_CONTAIN curl-args...
check() {
  local name="$1" expected="$2" needle="$3"; shift 3
  local out body status
  out="$("${CURL[@]}" --output - --write-out '\n%{http_code}' "$@" 2>&1)"
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
  body="${body//$'\n'/ }"
  if [[ "$status" != "$expected" ]]; then
    if [[ "$body" == *FUNCTION_INVOCATION_FAILED* ]]; then
      fail "$name" "HTTP $status FUNCTION_INVOCATION_FAILED (the function crashed before handling the request)"
    else
      fail "$name" "HTTP $status, expected $expected: ${body:0:120}"
    fi
    return
  fi
  if [[ -n "$needle" && "$body" != *"$needle"* ]]; then
    fail "$name" "HTTP $status but body lacks $needle: ${body:0:120}"
    return
  fi
  pass "$name" "HTTP $status"
}

echo "==> sync server: $SYNC_URL"
# Unknown route 404s before any auth or DB work: proves the module loaded and routes.
check "GET /nope" 404 '"error"' "$SYNC_URL/nope"
# A non-allowlisted token on a billing-enabled server gets 402, but only after
# the subscription lookup in Neon, so this exercises the database path.
check "GET /api/status (unsubscribed probe)" 402 '"subscribe":true' \
  -H "Authorization: Bearer $PROBE_TOKEN" "$SYNC_URL/api/status"
# The entitlement mint reads Neon and signs with the server secret.
check "POST /api/entitlement (probe)" 200 '"active":false' \
  -X POST -H "Authorization: Bearer $PROBE_TOKEN" "$SYNC_URL/api/entitlement"

echo "==> connector server: $CONNECTOR_URL"
# An unknown bearer on /mcp is refused with 401 by the connector's own auth
# layer; a crashed function answers 500 instead.
check "POST /mcp (unknown bearer)" 401 '' \
  -X POST -H 'content-type: application/json' -H "Authorization: Bearer $PROBE_TOKEN" \
  --data '{"jsonrpc":"2.0","id":1,"method":"ping"}' "$CONNECTOR_URL/mcp"

if (( failures > 0 )); then
  echo "PROBE FAILED: $failures check(s) failed."
  exit 1
fi
echo "PROBE OK: all checks passed."
