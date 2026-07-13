#!/usr/bin/env bash
# Verify the hosted sync server's paywall is live and gating — run AFTER
# flipping Stripe to live mode and deploying the live env to the server.
#
#   scripts/verify-golive.sh [SERVER_URL]
#   (default SERVER_URL: https://northkeep-sync-server.vercel.app)
#
# It stands up a THROWAWAY account (its own temp NORTHKEEP_HOME + a fresh,
# non-allowlisted device secret), points it at the live server, and tries to
# push. A correctly-gated server answers HTTP 402 (subscription required),
# which the CLI surfaces as "requires a $10/month subscription". Nothing is
# stored server-side on a 402, and your real ~/.northkeep vault is never
# touched. This does NOT test a real payment — that's the manual card-4242
# (test) or a real card (live) flow through `northkeep sync subscribe`.
set -euo pipefail

SERVER="${1:-https://northkeep-sync-server.vercel.app}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="node $REPO_ROOT/packages/cli/dist/index.js"

HOME_DIR="$(mktemp -d)"
export NORTHKEEP_HOME="$HOME_DIR"
export NORTHKEEP_PASSPHRASE="throwaway go-live verification passphrase"
cleanup() { rm -rf "$HOME_DIR"; }
trap cleanup EXIT

echo "==> Verifying paywall on: $SERVER"
echo "    (throwaway account in $HOME_DIR — your real vault is untouched)"

$CLI init >/dev/null 2>&1
$CLI remember "go-live smoke test" --type semantic >/dev/null 2>&1
$CLI sync config --server "$SERVER" >/dev/null 2>&1

echo "==> Attempting a push with a fresh, unsubscribed, non-allowlisted account…"
set +e
OUT="$($CLI sync push 2>&1)"
CODE=$?
set -e

echo "--- server/CLI said ---"
echo "$OUT" | sed 's/^/    /'
echo "-----------------------"

if echo "$OUT" | grep -qiE 'subscription|requires a \$10'; then
  echo "✅ PASS — the server is gating: an unsubscribed account was refused (402)."
  echo "   Billing is live and enforcing. Now confirm a real subscribe→push works"
  echo "   end-to-end via: northkeep sync subscribe  (card 4242 in test mode)."
  exit 0
elif [ $CODE -eq 0 ]; then
  echo "⚠️  WARNING — the push SUCCEEDED without a subscription."
  echo "   Either billing env is not set on the server (open/allowlist-only mode),"
  echo "   or this account is somehow allowlisted. Check STRIPE_* env on the server."
  exit 1
else
  echo "❌ The push failed, but not with a subscription-required message."
  echo "   Investigate the output above (server URL, deploy health, or a bug)."
  exit 2
fi
