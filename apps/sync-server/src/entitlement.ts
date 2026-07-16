import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Connector entitlement tokens (ADR 0019, phase C3 billing gate).
 *
 * The sync server is the ONLY service that knows whether a device's subscription
 * is active (it holds the Stripe link). The connector server must gate on that
 * without ever learning which account is which. The bridge is a short-lived,
 * HMAC-signed token that attests ONLY "the bearer is an active subscriber" — it
 * carries NO account id, vault id, or Stripe id. The desktop fetches it from the
 * sync server (authenticated with its sync token) and forwards it to the
 * connector as an opaque `X-NB-Entitlement` header on pair/push.
 *
 * The token is `base64url(canonicalJson) + "." + hex(HMAC-SHA256)`, keyed by the
 * shared secret `CONNECTOR_ENTITLEMENT_SECRET`. The canonical JSON has a FIXED
 * key order so both services sign/verify identical bytes.
 */

const ENTITLEMENT_TTL_SEC = 60 * 60; // 1 hour — short; the desktop re-fetches on each push

export interface EntitlementClaims {
  /** True iff the account has a live, non-expired subscription. */
  active: boolean;
  /** Subscription current_period_end (unix seconds), or 0 when inactive. */
  period_end: number;
  /** Token expiry (unix seconds). */
  exp: number;
  /** Random per-token nonce so two tokens are never byte-identical. */
  nonce: string;
}

/** Deterministic serialization with a fixed key order — the exact bytes signed. */
function canonical(claims: EntitlementClaims): string {
  return JSON.stringify({
    active: claims.active,
    period_end: claims.period_end,
    exp: claims.exp,
    nonce: claims.nonce,
  });
}

function sign(canonicalJson: string, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson, 'utf8').digest('hex');
}

/** Mint an entitlement token attesting the subscriber's current status. */
export function signEntitlement(
  secret: string,
  input: { active: boolean; periodEnd: number },
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const claims: EntitlementClaims = {
    active: input.active,
    period_end: input.active ? input.periodEnd : 0,
    exp: nowSec + ENTITLEMENT_TTL_SEC,
    nonce: randomBytes(12).toString('hex'),
  };
  const body = canonical(claims);
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${sign(body, secret)}`;
}

/**
 * The entitlement secret, or null when unset (billing bridge off — self-host).
 */
export function entitlementSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.CONNECTOR_ENTITLEMENT_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

/**
 * Verify a token and return its claims, or null if malformed, forged, expired,
 * or inactive. Shared shape with the connector server's verifier (kept in sync
 * by the fixed canonical form above). Exported here so the sync server's own
 * tests can round-trip.
 */
export function verifyEntitlement(
  secret: string,
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): EntitlementClaims | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const bodyB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let body: string;
  try {
    body = Buffer.from(bodyB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(body, secret);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: EntitlementClaims;
  try {
    claims = JSON.parse(body) as EntitlementClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) return null;
  if (claims.active !== true) return null;
  return claims;
}
