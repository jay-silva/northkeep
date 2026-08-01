import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveConnectorToken, deriveSyncCreds, tokenHash } from '@northkeep/sync';
import { allowlistHashFromToken, shareIdFromConnectorToken } from '../src/lib/connect-flow';

/**
 * A comp id is only useful if it is byte-identical to what the server stores.
 * The phone cannot use node:crypto, so these go through @noble/hashes, and the
 * whole value of the feature rests on the two agreeing exactly. A hash that is
 * merely plausible sends a design partner an id that silently never matches.
 */
describe('allowlist hashes match the server and the desktop CLI', () => {
  const deviceSecret = Buffer.alloc(32, 42);

  it('the SYNC id equals tokenHash of the sync token (NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES)', () => {
    const { token } = deriveSyncCreds(deviceSecret);
    expect(allowlistHashFromToken(token)).toBe(tokenHash(token));
    // and byte-for-byte against node's own sha256, not just our helper
    expect(allowlistHashFromToken(token)).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
  });

  it('the CLOUD CONNECT id equals tokenHash of the connector token', () => {
    const connector = deriveConnectorToken(deviceSecret);
    expect(shareIdFromConnectorToken(connector)).toBe(tokenHash(connector));
  });

  /**
   * The bug this feature fixes: Settings showed the ACCOUNT id, which is a
   * different derivation label. Sending it to support would never match the
   * sync allowlist, so a phone-only partner could not be comped at all.
   */
  it('the sync id is NOT the account id, and not the Cloud Connect id either', () => {
    const { token, accountId } = deriveSyncCreds(deviceSecret);
    const syncId = allowlistHashFromToken(token);
    const connectorId = shareIdFromConnectorToken(deriveConnectorToken(deviceSecret));
    expect(syncId).not.toBe(accountId);
    expect(syncId).not.toBe(connectorId);
    expect(syncId).toMatch(/^[0-9a-f]{64}$/);
  });
});
