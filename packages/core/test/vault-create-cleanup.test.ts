import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { getPlatform, type Platform } from '../src/platform-context.js';
import { Vault } from '../src/vault.js';

// Finding 9: if save()/init throws mid-create(), the derived master key must be
// memzero'd and the db closed before the error propagates — matching
// openDecrypting's discipline, so a failed create leaves no key material for GC.
describe('Vault.create failure cleanup', () => {
  it('zeroizes the derived master key and closes the db when save() throws', () => {
    const base = getPlatform();

    // Capture the exact derived-key buffer so we can prove THAT buffer was zeroed
    // (deriveMasterKey also zeroes its own scratch buffers, so a bare call count
    // would not be decisive).
    let derivedKey: Uint8Array | undefined;
    const generichashSecure = (a: Buffer, b: Buffer): Buffer => {
      const k = base.crypto.generichashSecure(a, b);
      derivedKey = k;
      return k;
    };
    const secureZero = vi.fn((buf: Uint8Array) => base.crypto.secureZero(buf));

    // Spy on the created db's close().
    let dbClose: ReturnType<typeof vi.fn> | undefined;

    const platform: Platform = {
      crypto: { ...base.crypto, generichashSecure, secureZero },
      sqlite: {
        ...base.sqlite,
        createEmpty: () => {
          const db = base.sqlite.createEmpty();
          const realClose = db.close.bind(db);
          dbClose = vi.fn(() => realClose());
          db.close = dbClose;
          return db;
        },
      },
      // Force save() to throw after the key is derived and the db is populated.
      storage: {
        ...base.storage,
        writeAtomic: () => {
          throw new Error('disk full (injected)');
        },
      },
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-create-fail-'));
    const vaultPath = path.join(dir, 'vault.nkv');
    const deviceSecret = generateDeviceSecret();
    try {
      expect(() =>
        Vault.create({
          path: vaultPath,
          passphrase: 'a strong test passphrase',
          deviceSecret,
          kdf: KDF_INTERACTIVE,
          platform,
        }),
      ).toThrow(/disk full/);

      // The db opened during create() was closed on the error path.
      expect(dbClose).toHaveBeenCalledTimes(1);
      // The exact derived master key was zeroed (not just some scratch buffer).
      expect(derivedKey).toBeDefined();
      expect(secureZero.mock.calls.some(([buf]) => buf === derivedKey)).toBe(true);
      // Nothing partial on disk (writeAtomic threw before writing anything).
      expect(fs.existsSync(vaultPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
