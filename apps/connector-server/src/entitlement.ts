import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Connector-side of the entitlement bridge (ADR 0019, phase C3 billing gate).
 *
 * The desktop forwards an opaque `X-NB-Entitlement` header — an anonymous
 * "active subscriber" attestation minted by the sync server. This module
 * verifies it against the SHARED secret `CONNECTOR_ENTITLEMENT_SECRET`. The
 * canonical form (fixed key order, base64url(body) + "." + hex(HMAC-SHA256))
 * matches apps/sync-server/src/entitlement.ts byte-for-byte. No @northkeep/core
 * import here (keeps the serverless bundle off sodium-native).
 *
 * A valid+unexpired+active token lets the connector stamp a grace window on the
 * account row; forged/expired/inactive tokens verify to null (→ HTTP 402 on the
 * gated routes when the gate is on).
 */

export interface EntitlementClaims {
  active: boolean;
  period_end: number;
  exp: number;
  nonce: string;
}

/** The grace window a valid entitlement buys, from the moment it is presented. */
export const ENTITLEMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sign(canonicalJson: string, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson, 'utf8').digest('hex');
}

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

/** Parse the connector's free/comp allowlist (comma/space separated sha256 hashes). */
export function parseConnectorAllowlist(raw: string | undefined): ReadonlySet<string> | null {
  if (!raw) return null;
  const hashes = raw
    .split(/[,\s]+/)
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[0-9a-f]{64}$/.test(h));
  return hashes.length > 0 ? new Set(hashes) : null;
}

export interface ConnectorGate {
  /** true when the gate is active (at least one env set); false ⇒ everything is allowed. */
  on: boolean;
  allowlist: ReadonlySet<string> | null;
  entitlementSecret: string | null;
}

/**
 * Build the gate from env. Mirrors billingFromEnv's spirit: NEITHER var set ⇒
 * gate OFF (self-host / local dev, exactly like the C1/C2 tests). Either set ⇒
 * gate ON (allowlist alone = private connector; secret alone = paid connector;
 * both = paid with comps).
 */
export function connectorGateFromEnv(env: NodeJS.ProcessEnv = process.env): ConnectorGate {
  const allowlist = parseConnectorAllowlist(env.NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES);
  const entitlementSecret =
    env.CONNECTOR_ENTITLEMENT_SECRET && env.CONNECTOR_ENTITLEMENT_SECRET.length > 0
      ? env.CONNECTOR_ENTITLEMENT_SECRET
      : null;
  return { on: allowlist !== null || entitlementSecret !== null, allowlist, entitlementSecret };
}
