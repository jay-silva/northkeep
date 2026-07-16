import { describe, expect, it } from 'vitest';
import {
  ConnectorCryptoError,
  KEK_LABEL_AUTH_CODE,
  KEK_LABEL_CONNECTOR_TOKEN,
  KEK_LABEL_PAIRING_CODE,
  KEK_LABEL_TOKEN,
  decryptRow,
  deriveKek,
  encryptRow,
  generateDek,
  isEncryptedRow,
  unwrapDek,
  wrapDek,
} from '../src/crypto.js';

/**
 * ADR 0020 crypto module unit tests: round-trips, the failure modes that make
 * the ciphertext-only claim falsifiable (wrong KEK, wrong-account AAD), the
 * versioned formats, and legacy-plaintext detection.
 */

const ACCOUNT = 'a'.repeat(64);
const OTHER_ACCOUNT = 'b'.repeat(64);

describe('ADR 0020 crypto module', () => {
  it('wrap/unwrap round-trips a DEK under a credential-derived KEK', async () => {
    const dek = await generateDek();
    expect(dek).toHaveLength(32);
    const kek = await deriveKek(KEK_LABEL_CONNECTOR_TOKEN, 'the-connector-token');
    const wrap = await wrapDek(dek, kek);
    expect(await unwrapDek(wrap, kek)).toEqual(dek);
  });

  it('a wrap does NOT open under a wrong credential or a wrong domain label', async () => {
    const dek = await generateDek();
    const kek = await deriveKek(KEK_LABEL_TOKEN, 'refresh-token-plaintext');
    const wrap = await wrapDek(dek, kek);
    // Same label, different credential.
    const wrongCred = await deriveKek(KEK_LABEL_TOKEN, 'a-different-token');
    await expect(unwrapDek(wrap, wrongCred)).rejects.toBeInstanceOf(ConnectorCryptoError);
    // Same credential, different credential-class label (domain separation).
    const wrongLabel = await deriveKek(KEK_LABEL_AUTH_CODE, 'refresh-token-plaintext');
    await expect(unwrapDek(wrap, wrongLabel)).rejects.toBeInstanceOf(ConnectorCryptoError);
  });

  it('each credential class derives a DISTINCT KEK from the same secret', async () => {
    const secret = 'one-secret';
    const keks = await Promise.all(
      [KEK_LABEL_CONNECTOR_TOKEN, KEK_LABEL_PAIRING_CODE, KEK_LABEL_AUTH_CODE, KEK_LABEL_TOKEN].map((l) =>
        deriveKek(l, secret),
      ),
    );
    const hex = keks.map((k) => Buffer.from(k).toString('hex'));
    expect(new Set(hex).size).toBe(4);
  });

  it('encryptRow/decryptRow round-trips the {type, content} envelope', async () => {
    const dek = await generateDek();
    const stored = await encryptRow({ accountHash: ACCOUNT, type: 'semantic', content: 'the 0800 QA/QI review' }, dek);
    const plain = await decryptRow(stored, ACCOUNT, dek);
    expect(plain).toEqual({ type: 'semantic', content: 'the 0800 QA/QI review' });
    // The stored string reveals nothing of the plaintext.
    expect(stored).not.toContain('QA/QI');
    expect(stored).not.toContain('semantic');
  });

  it('a row does not decrypt under the wrong DEK', async () => {
    const stored = await encryptRow({ accountHash: ACCOUNT, type: 'fact', content: 'x' }, await generateDek());
    await expect(decryptRow(stored, ACCOUNT, await generateDek())).rejects.toBeInstanceOf(ConnectorCryptoError);
  });

  it('AAD binds the row to its account: a cross-account ciphertext transplant fails', async () => {
    const dek = await generateDek();
    const stored = await encryptRow({ accountHash: ACCOUNT, type: 'fact', content: 'x' }, dek);
    // Same DEK, different account in the AAD — the transplant that matters.
    await expect(decryptRow(stored, OTHER_ACCOUNT, dek)).rejects.toBeInstanceOf(ConnectorCryptoError);
  });

  it('versioned formats: nkw1 wraps, nkc1 rows, and malformed values are typed errors', async () => {
    const dek = await generateDek();
    const kek = await deriveKek(KEK_LABEL_PAIRING_CODE, 'ABCD2345');
    const wrap = await wrapDek(dek, kek);
    expect(wrap).toMatch(/^nkw1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    const row = await encryptRow({ accountHash: ACCOUNT, type: 't', content: 'c' }, dek);
    expect(row).toMatch(/^nkc1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    await expect(unwrapDek('not-a-wrap', kek)).rejects.toBeInstanceOf(ConnectorCryptoError);
    await expect(unwrapDek(row, kek)).rejects.toBeInstanceOf(ConnectorCryptoError); // nkc1 is not nkw1
    await expect(decryptRow('nkc1:only-two-parts', ACCOUNT, dek)).rejects.toBeInstanceOf(ConnectorCryptoError);
  });

  it('isEncryptedRow detects legacy plaintext', async () => {
    const dek = await generateDek();
    expect(isEncryptedRow(await encryptRow({ accountHash: ACCOUNT, type: 't', content: 'c' }, dek))).toBe(true);
    expect(isEncryptedRow('The user chairs the Tuesday review.')).toBe(false);
    expect(isEncryptedRow('')).toBe(false);
    expect(isEncryptedRow('nkw1:abc:def')).toBe(false); // a wrap is not a row
  });

  it('nonces are fresh: encrypting the same envelope twice yields different ciphertexts', async () => {
    const dek = await generateDek();
    const a = await encryptRow({ accountHash: ACCOUNT, type: 't', content: 'same' }, dek);
    const b = await encryptRow({ accountHash: ACCOUNT, type: 't', content: 'same' }, dek);
    expect(a).not.toBe(b);
    expect(await decryptRow(a, ACCOUNT, dek)).toEqual(await decryptRow(b, ACCOUNT, dek));
  });
});
