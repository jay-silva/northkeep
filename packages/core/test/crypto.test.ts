import { describe, expect, it } from 'vitest';
import {
  KDF_INTERACTIVE,
  SALT_BYTES,
  VaultAuthError,
  blake2bHex,
  decrypt,
  deriveMasterKey,
  encrypt,
  generateDeviceSecret,
  randomBytes,
} from '../src/crypto.js';

const kdf = KDF_INTERACTIVE; // fast params for tests; production uses MODERATE

describe('key derivation', () => {
  const salt = randomBytes(SALT_BYTES);
  const deviceSecret = generateDeviceSecret();

  it('is deterministic for the same inputs', () => {
    const a = deriveMasterKey('correct horse battery', deviceSecret, salt, kdf);
    const b = deriveMasterKey('correct horse battery', deviceSecret, salt, kdf);
    expect(a.equals(b)).toBe(true);
  });

  it('changes with the passphrase', () => {
    const a = deriveMasterKey('passphrase-one', deviceSecret, salt, kdf);
    const b = deriveMasterKey('passphrase-two', deviceSecret, salt, kdf);
    expect(a.equals(b)).toBe(false);
  });

  it('changes with the device secret (two-secret property)', () => {
    const a = deriveMasterKey('same passphrase', deviceSecret, salt, kdf);
    const b = deriveMasterKey('same passphrase', generateDeviceSecret(), salt, kdf);
    expect(a.equals(b)).toBe(false);
  });

  it('changes with the salt', () => {
    const a = deriveMasterKey('same passphrase', deviceSecret, salt, kdf);
    const b = deriveMasterKey('same passphrase', deviceSecret, randomBytes(SALT_BYTES), kdf);
    expect(a.equals(b)).toBe(false);
  });
});

describe('AEAD encrypt/decrypt', () => {
  const key = randomBytes(32);
  const ad = Buffer.from('header-bytes');

  it('round-trips', () => {
    const plain = Buffer.from('the vault contents');
    const { nonce, ciphertext } = encrypt(plain, key, ad);
    expect(decrypt(ciphertext, key, nonce, ad).equals(plain)).toBe(true);
  });

  it('produces no plaintext in the ciphertext', () => {
    const marker = 'SSN 000-12-3456 must not appear';
    const { ciphertext } = encrypt(Buffer.from(marker), key, ad);
    expect(ciphertext.includes(Buffer.from(marker))).toBe(false);
  });

  it('rejects a tampered ciphertext', () => {
    const { nonce, ciphertext } = encrypt(Buffer.from('data'), key, ad);
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    expect(() => decrypt(ciphertext, key, nonce, ad)).toThrow(VaultAuthError);
  });

  it('rejects tampered associated data', () => {
    const { nonce, ciphertext } = encrypt(Buffer.from('data'), key, ad);
    expect(() => decrypt(ciphertext, key, nonce, Buffer.from('other-header'))).toThrow(
      VaultAuthError,
    );
  });

  it('rejects the wrong key', () => {
    const { nonce, ciphertext } = encrypt(Buffer.from('data'), key, ad);
    expect(() => decrypt(ciphertext, randomBytes(32), nonce, ad)).toThrow(VaultAuthError);
  });
});

describe('blake2bHex', () => {
  it('is a stable 64-hex-char digest', () => {
    const digest = blake2bHex('abc');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(blake2bHex('abc')).toBe(digest);
    expect(blake2bHex('abd')).not.toBe(digest);
  });
});
