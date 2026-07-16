/**
 * Node-runnable byte-exactness proof for the mobile platform adapters
 * (ADR 0021), replicating the passing Week-1 spike approach: the RN native
 * modules cannot run under Node, so their wasm/OpenSSL equivalents stand in —
 *
 *   react-native-libsodium    → libsodium-wrappers-sumo (the SAME libsodium,
 *                               compiled to wasm; also the documented Hermes
 *                               fallback ladder rung)
 *   react-native-quick-crypto → node:crypto.argon2Sync (quick-crypto tracks
 *                               the node:crypto API; the SAME wrapper factory,
 *                               createNodeCryptoArgon2id, wires either one)
 *   expo-sqlite               → sql.js (a third, independent SQLite build,
 *                               exercising the whole-file image contract)
 *
 * Every assertion is against RAW BYTES produced by @northkeep/platform-node
 * (sodium-native + better-sqlite3), the reference desktop adapter. What these
 * tests prove: the mobile adapter LOGIC — parameter mapping, AAD/nonce/key
 * plumbing, header layout, image round-trip — is byte-identical to desktop.
 * What they cannot prove: the RN bindings themselves behave like their
 * stand-ins on a physical device. That requires the on-device spike run and
 * the invariant-#3 adversarial review before any real vault is trusted to
 * this code (ADR 0021).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeCrypto from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import _sumo from 'libsodium-wrappers-sumo';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import {
  KDF_INTERACTIVE,
  KDF_MODERATE,
  NONCE_BYTES,
  SALT_BYTES,
  Vault,
  computeEntryHash,
  deriveMasterKey,
  type CryptoProvider,
  type MemoryEntry,
} from '@northkeep/core';
import { nodeCryptoProvider, nodePlatform } from '@northkeep/platform-node';
import {
  argon2ParamsFromSodium,
  createNobleArgon2id,
  createNodeCryptoArgon2id,
  pwhashViaArgon2id,
  type NodeStyleArgon2Module,
} from '../src/argon2.js';
import { createMobileCryptoProvider } from '../src/crypto.js';
import { encodeDeviceSecretHex, parseDeviceSecretHex } from '../src/device-secret-format.js';
import type { SodiumApi } from '../src/sodium-api.js';
import { isNamedParamsObject, toExpoBindParams } from '../src/sqlite-params.js';

/** node:crypto stands in for react-native-quick-crypto. argon2Sync landed in
 * Node 24.7 (OpenSSL 3.2's Argon2); the cast bridges @types/node versions that
 * predate it. Evaluated at module scope so it.skipIf can read it at COLLECTION
 * time. When absent (e.g. CI's Node 20), the quick-crypto MAPPING assertions
 * skip loudly rather than reddening the whole desktop suite; the KDF and full
 * vault-pipeline proofs still run in CI via the wasm-libsodium fallback rung. */
const nodeArgon2 = nodeCrypto as unknown as NodeStyleArgon2Module;
const nodeArgon2Available = typeof nodeArgon2.argon2Sync === 'function';

const reference = nodeCryptoProvider();
/** Mobile provider on the real device KDF path (node:crypto/quick-crypto
 * argon2Sync). Constructing it never invokes argon2 — createMobileCryptoProvider
 * only asserts sodium constants — so it builds even where argon2Sync is absent;
 * every test that INVOKES its pwhash/deriveMasterKey is gated on
 * nodeArgon2Available. */
let mobile: CryptoProvider;
/** Mobile provider whose Argon2id is wasm-libsodium crypto_pwhash (the sumo
 * fallback rung). Runs on every Node so the master-key + .nkv pipeline proof
 * stays in CI even when node:crypto.argon2Sync is unavailable. Byte-exact to
 * sodium-native, so its assertions are as strong as the quick-crypto path's. */
let wasmKdfMobile: CryptoProvider;
let SQL: SqlJsStatic;

beforeAll(async () => {
  if (!nodeArgon2Available) {
    console.warn(
      '\n[platform-mobile byte-exact] node:crypto.argon2Sync is unavailable ' +
        '(needs Node >= 24.7). The react-native-quick-crypto MAPPING assertions ' +
        'are SKIPPED; KDF and .nkv pipeline proofs still run on the wasm-libsodium ' +
        'fallback. Run on Node >= 24.7 to exercise the quick-crypto path.\n',
    );
  }
  await _sumo.ready;
  // libsodium-wrappers-sumo satisfies the SodiumApi seam the same way
  // react-native-libsodium does (both mirror the libsodium-wrappers API).
  const sodium = _sumo as unknown as SodiumApi;
  mobile = createMobileCryptoProvider({
    sodium,
    argon2id: createNodeCryptoArgon2id(nodeArgon2),
  });
  // Reconstruct memlimit = memory * 1024: both libsodium builds floor m_cost to
  // KiB, so this yields output byte-identical to the original memlimit.
  wasmKdfMobile = createMobileCryptoProvider({
    sodium,
    argon2id: (p) =>
      _sumo.crypto_pwhash(
        p.tagLength,
        p.message,
        p.nonce,
        p.passes,
        p.memory * 1024,
        _sumo.crypto_pwhash_ALG_ARGON2ID13,
      ),
  });
  SQL = await initSqlJs();
});

const PASSPHRASE = 'correct horse battery staple';
const passBytes = () => Buffer.from(PASSPHRASE, 'utf8');
const salt = Buffer.alloc(SALT_BYTES, 7);
const deviceSecret = Buffer.alloc(32, 0x42);

/** The 52-byte .nkv header: NKV1 | salt 16B | opslimit u32LE | memlimit u32LE | nonce 24B. */
function buildHeader(s: Buffer, opslimit: number, memlimit: number, nonce: Buffer): Buffer {
  const header = Buffer.alloc(4 + SALT_BYTES + 4 + 4 + NONCE_BYTES);
  header.write('NKV1', 0, 'ascii');
  s.copy(header, 4);
  header.writeUInt32LE(opslimit, 4 + SALT_BYTES);
  header.writeUInt32LE(memlimit, 4 + SALT_BYTES + 4);
  nonce.copy(header, 4 + SALT_BYTES + 8);
  return header;
}

describe('Argon2id KDF (sodium crypto_pwhash contract)', () => {
  // --- Always-on legs: no node:crypto.argon2Sync needed, so they run in CI. ---

  it('the noble pure-JS Argon2id (the DEVICE backend) matches sodium-native, incl. odd memlimit', () => {
    // @noble/hashes argon2id is what native.ts wires on device (quick-crypto's
    // native Argon2 Nitro object fails to register). Prove the exact pwhash path
    // the phone runs is byte-identical to the desktop reference.
    const noble = createNobleArgon2id();
    const oddMemlimit = KDF_INTERACTIVE.memlimit + 512; // exercises the /1024 floor
    for (const mem of [KDF_INTERACTIVE.memlimit, oddMemlimit]) {
      const want = reference.pwhash(passBytes(), salt, KDF_INTERACTIVE.opslimit, mem);
      const got = pwhashViaArgon2id(noble, passBytes(), salt, KDF_INTERACTIVE.opslimit, mem);
      expect(Buffer.from(got).equals(want)).toBe(true);
    }
  });

  it('wasm libsodium crypto_pwhash matches sodium-native (INTERACTIVE)', () => {
    const want = reference.pwhash(passBytes(), salt, KDF_INTERACTIVE.opslimit, KDF_INTERACTIVE.memlimit);
    const got = _sumo.crypto_pwhash(
      32,
      passBytes(),
      salt,
      KDF_INTERACTIVE.opslimit,
      KDF_INTERACTIVE.memlimit,
      _sumo.crypto_pwhash_ALG_ARGON2ID13,
    );
    expect(Buffer.from(got).equals(want)).toBe(true);
  });

  it('wasm libsodium crypto_pwhash matches sodium-native (MODERATE — production vault params)', () => {
    const want = reference.pwhash(passBytes(), salt, KDF_MODERATE.opslimit, KDF_MODERATE.memlimit);
    const got = _sumo.crypto_pwhash(
      32,
      passBytes(),
      salt,
      KDF_MODERATE.opslimit,
      KDF_MODERATE.memlimit,
      _sumo.crypto_pwhash_ALG_ARGON2ID13,
    );
    expect(Buffer.from(got).equals(want)).toBe(true);
  });

  it('the wasm-KDF mobile provider (fallback rung) matches sodium-native, incl. odd memlimit', () => {
    // core's kdfParamsInBounds accepts any in-range integer, so a header could
    // legally carry a non-multiple-of-1024 memlimit; both platforms must floor
    // identically to KiB. This runs on every Node, so the KDF byte-exactness of
    // the actual mobile provider is proven in CI even without argon2Sync.
    const oddMemlimit = KDF_INTERACTIVE.memlimit + 512;
    for (const mem of [KDF_INTERACTIVE.memlimit, oddMemlimit]) {
      const want = reference.pwhash(passBytes(), salt, KDF_INTERACTIVE.opslimit, mem);
      const got = wasmKdfMobile.pwhash(passBytes(), salt, KDF_INTERACTIVE.opslimit, mem);
      expect(got.equals(want)).toBe(true);
    }
  });

  // --- quick-crypto MAPPING legs: gated on node:crypto.argon2Sync (Node >=24.7). ---

  it.skipIf(!nodeArgon2Available)(
    'react-native-quick-crypto stand-in (node:crypto.argon2Sync) matches sodium-native (INTERACTIVE)',
    () => {
      const want = reference.pwhash(passBytes(), salt, KDF_INTERACTIVE.opslimit, KDF_INTERACTIVE.memlimit);
      const got = mobile.pwhash(passBytes(), salt, KDF_INTERACTIVE.opslimit, KDF_INTERACTIVE.memlimit);
      expect(got.length).toBe(32);
      expect(got.equals(want)).toBe(true);
    },
  );

  it.skipIf(!nodeArgon2Available)(
    'react-native-quick-crypto stand-in matches sodium-native (MODERATE — production vault params)',
    () => {
      const want = reference.pwhash(passBytes(), salt, KDF_MODERATE.opslimit, KDF_MODERATE.memlimit);
      const got = pwhashViaArgon2id(
        createNodeCryptoArgon2id(nodeArgon2),
        passBytes(),
        salt,
        KDF_MODERATE.opslimit,
        KDF_MODERATE.memlimit,
      );
      expect(Buffer.from(got).equals(want)).toBe(true);
    },
  );

  it.skipIf(!nodeArgon2Available)(
    'react-native-quick-crypto stand-in floors an odd memlimit exactly like sodium-native',
    () => {
      const oddMemlimit = KDF_INTERACTIVE.memlimit + 512;
      const want = reference.pwhash(passBytes(), salt, KDF_INTERACTIVE.opslimit, oddMemlimit);
      const got = mobile.pwhash(passBytes(), salt, KDF_INTERACTIVE.opslimit, oddMemlimit);
      expect(got.equals(want)).toBe(true);
    },
  );

  // --- Pure param-mapping unit tests: no crypto backend, always run. ---

  it('maps sodium params to Argon2id exactly (t=ops, mKiB=mem/1024, p=1, tag=32)', () => {
    const p = argon2ParamsFromSodium(passBytes(), salt, 3, 268_435_456);
    expect(p).toMatchObject({ passes: 3, memory: 262_144, parallelism: 1, tagLength: 32 });
    expect(Buffer.from(p.nonce).equals(salt)).toBe(true);
    // Non-multiple-of-1024 memlimit floors to KiB, matching libsodium.
    const oddMemlimit = KDF_INTERACTIVE.memlimit + 512;
    expect(argon2ParamsFromSodium(passBytes(), salt, 2, oddMemlimit).memory).toBe(
      Math.floor(oddMemlimit / 1024),
    );
  });

  it('rejects out-of-contract inputs (wrong salt length, ops < 1, mem < 8192)', () => {
    expect(() => argon2ParamsFromSodium(passBytes(), Buffer.alloc(8), 2, 65536)).toThrow(/salt/);
    expect(() => argon2ParamsFromSodium(passBytes(), salt, 0, 65536)).toThrow(/opslimit/);
    expect(() => argon2ParamsFromSodium(passBytes(), salt, 2, 4096)).toThrow(/memlimit/);
  });
});

describe('BLAKE2b + master key derivation', () => {
  const message = Buffer.from('the quick brown fox', 'utf8');

  it('unkeyed BLAKE2b-256 (hash chain primitive) matches sodium-native', () => {
    expect(mobile.generichash(message).equals(reference.generichash(message))).toBe(true);
  });

  it('keyed BLAKE2b-256 matches sodium-native', () => {
    expect(
      mobile.generichash(message, deviceSecret).equals(reference.generichash(message, deviceSecret)),
    ).toBe(true);
  });

  it('generichashSecure is byte-identical to generichash (guarded memory is Node-only hardening)', () => {
    expect(
      mobile.generichashSecure(message, deviceSecret).equals(mobile.generichash(message, deviceSecret)),
    ).toBe(true);
  });

  it('sync credential derivations (nk-sync-*-v1 labels) match desktop', () => {
    for (const label of ['nk-sync-account-v1', 'nk-sync-token-v1']) {
      const msg = Buffer.from(label, 'utf8');
      expect(
        mobile.generichash(msg, deviceSecret).equals(reference.generichash(msg, deviceSecret)),
      ).toBe(true);
    }
  });

  it('deriveMasterKey (wasm-libsodium Argon2id → keyed BLAKE2b) yields the identical master key', () => {
    // Always-on: proves the full two-secret derivation byte-exact in CI.
    const want = deriveMasterKey(PASSPHRASE, deviceSecret, salt, KDF_INTERACTIVE, reference);
    const got = deriveMasterKey(PASSPHRASE, deviceSecret, salt, KDF_INTERACTIVE, wasmKdfMobile);
    expect(got.length).toBe(32);
    expect(got.equals(want)).toBe(true);
  });

  it.skipIf(!nodeArgon2Available)(
    'deriveMasterKey on the quick-crypto path (node:crypto.argon2Sync) yields the identical master key',
    () => {
      const want = deriveMasterKey(PASSPHRASE, deviceSecret, salt, KDF_INTERACTIVE, reference);
      const got = deriveMasterKey(PASSPHRASE, deviceSecret, salt, KDF_INTERACTIVE, mobile);
      expect(got.equals(want)).toBe(true);
    },
  );

  it('secureZero scrubs the buffer', () => {
    const buf = mobile.randomBytes(32);
    mobile.secureZero(buf);
    expect(buf.equals(Buffer.alloc(32))).toBe(true);
  });
});

describe('XChaCha20-Poly1305 AEAD with the 52-byte header as AAD', () => {
  const key = Buffer.alloc(32, 0x5a);
  const nonce = Buffer.alloc(NONCE_BYTES, 3);
  const aad = buildHeader(salt, KDF_MODERATE.opslimit, KDF_MODERATE.memlimit, nonce);
  const plaintext = Buffer.from('SQLite format 3\0 pretend vault image payload', 'utf8');

  it('desktop-encrypted → mobile-decrypted round trip', () => {
    const ciphertext = reference.aeadEncrypt(plaintext, aad, nonce, key);
    expect(ciphertext.length).toBe(plaintext.length + 16);
    expect(mobile.aeadDecrypt(ciphertext, aad, nonce, key).equals(plaintext)).toBe(true);
  });

  it('mobile-encrypted → desktop-decrypted round trip', () => {
    const ciphertext = mobile.aeadEncrypt(plaintext, aad, nonce, key);
    expect(reference.aeadDecrypt(ciphertext, aad, nonce, key).equals(plaintext)).toBe(true);
  });

  it('ciphertext is byte-identical given the same nonce/key/aad', () => {
    expect(
      mobile.aeadEncrypt(plaintext, aad, nonce, key).equals(reference.aeadEncrypt(plaintext, aad, nonce, key)),
    ).toBe(true);
  });

  it('throws on a tampered ciphertext, wrong key, and wrong AAD', () => {
    const ciphertext = reference.aeadEncrypt(plaintext, aad, nonce, key);
    const tampered = Buffer.from(ciphertext);
    tampered[0] ^= 0x01;
    expect(() => mobile.aeadDecrypt(tampered, aad, nonce, key)).toThrow();
    expect(() => mobile.aeadDecrypt(ciphertext, aad, nonce, Buffer.alloc(32, 0x5b))).toThrow();
    const wrongAad = Buffer.from(aad);
    wrongAad[4] ^= 0x01; // flip one salt byte inside the header
    expect(() => mobile.aeadDecrypt(ciphertext, wrongAad, nonce, key)).toThrow();
  });
});

describe('.nkv vault image (expo-sqlite stand-in: sql.js, Spike 1 replication)', () => {
  const HEADER_LENGTH = 4 + SALT_BYTES + 4 + 4 + NONCE_BYTES;
  let dir: string;
  let vaultPath: string;
  let fileBytes: Buffer;
  let rememberedIds: string[];

  const rowQuery =
    'SELECT id, type, content, scope, prev_hash, entry_hash FROM memories ORDER BY rowid ASC';

  interface HeaderFields {
    salt: Buffer;
    opslimit: number;
    memlimit: number;
    nonce: Buffer;
    raw: Buffer;
  }

  function parseHeader(file: Buffer): HeaderFields {
    expect(file.subarray(0, 4).toString('ascii')).toBe('NKV1');
    return {
      salt: Buffer.from(file.subarray(4, 4 + SALT_BYTES)),
      opslimit: file.readUInt32LE(4 + SALT_BYTES),
      memlimit: file.readUInt32LE(4 + SALT_BYTES + 4),
      nonce: Buffer.from(file.subarray(4 + SALT_BYTES + 8, HEADER_LENGTH)),
      raw: Buffer.from(file.subarray(0, HEADER_LENGTH)),
    };
  }

  /** Decrypt the .nkv through the MOBILE adapter logic only. Defaults to the
   * wasm-KDF provider so the pipeline proof runs on every Node; the gated test
   * below re-runs it on the quick-crypto path to prove that opens the vault too. */
  function mobileDecryptVault(
    file: Buffer,
    provider: CryptoProvider = wasmKdfMobile,
  ): { image: Buffer; header: HeaderFields; key: Buffer } {
    const header = parseHeader(file);
    const key = deriveMasterKey(
      PASSPHRASE,
      deviceSecret,
      header.salt,
      { opslimit: header.opslimit, memlimit: header.memlimit },
      provider,
    );
    const image = provider.aeadDecrypt(
      Buffer.from(file.subarray(HEADER_LENGTH)),
      header.raw,
      header.nonce,
      key,
    );
    return { image, header, key };
  }

  function sqlJsRows(db: SqlJsDatabase): unknown[][] {
    const result = db.exec(rowQuery);
    return result.length === 0 ? [] : (result[0]!.values as unknown[][]);
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nk-mobile-byte-exact-'));
    vaultPath = path.join(dir, 'vault.nkv');
    const vault = Vault.create({
      path: vaultPath,
      passphrase: PASSPHRASE,
      deviceSecret,
      kdf: KDF_INTERACTIVE,
      platform: nodePlatform(),
    });
    const a = vault.remember({ content: 'Bourne FD budget review is Tuesday', type: 'episodic', scope: 'work' });
    const b = vault.remember({ content: 'Jay prefers concise answers', type: 'identity', scope: 'personal' });
    rememberedIds = [a.id, b.id];
    vault.save();
    vault.close();
    fileBytes = readFileSync(vaultPath);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mobile adapter logic alone decrypts a desktop-created .nkv to a SQLite image', () => {
    const { image } = mobileDecryptVault(fileBytes);
    expect(image.subarray(0, 15).toString('ascii')).toBe('SQLite format 3');
  });

  it('sql.js reads rows identical to better-sqlite3 from the same image', () => {
    const { image } = mobileDecryptVault(fileBytes);
    const wasmDb = new SQL.Database(image);
    const wasmRows = sqlJsRows(wasmDb);
    wasmDb.close();

    const driver = nodePlatform().sqlite;
    const nodeDb = driver.openFromImage(image);
    const nodeRows = (nodeDb.prepare(rowQuery).all() as Array<Record<string, unknown>>).map((r) => [
      r.id,
      r.type,
      r.content,
      r.scope,
      r.prev_hash,
      r.entry_hash,
    ]);
    nodeDb.close();

    expect(wasmRows).toHaveLength(2);
    expect(wasmRows).toEqual(nodeRows);
    expect(wasmRows.map((r) => r[0])).toEqual(rememberedIds);
  });

  it('unmodified deserialize → serialize round trip is byte-stable', () => {
    const { image } = mobileDecryptVault(fileBytes);
    const wasmDb = new SQL.Database(image);
    const reserialized = Buffer.from(wasmDb.export());
    wasmDb.close();
    expect(reserialized.equals(image)).toBe(true);
  });

  it('a mobile-side write re-encrypts into a vault the desktop opens with the chain intact', () => {
    const { image, header } = mobileDecryptVault(fileBytes);

    // Replicate remember() through the wasm stack: read the chain head, hash the
    // new entry with the MOBILE provider (unkeyed BLAKE2b via canonical JSON),
    // insert, advance the head.
    const wasmDb = new SQL.Database(image);
    const headRes = wasmDb.exec("SELECT value FROM vault_meta WHERE key = 'chain_head'");
    const chainHead = headRes[0]!.values[0]![0] as string;
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: '00000000-0000-4000-8000-000000000abc',
      type: 'episodic',
      content: 'added from the mobile wasm path',
      scope: 'work',
      source: 'test:mobile',
      source_model: null,
      confidence: 1,
      created_at: now,
      valid_from: now,
      superseded_at: null,
      superseded_by: null,
      forgotten_at: null,
      prev_hash: chainHead,
      entry_hash: '',
      metadata: null,
    };
    entry.entry_hash = computeEntryHash(entry, wasmKdfMobile);
    wasmDb.run(
      `INSERT INTO memories
       (id, type, content, scope, source, source_model, confidence, created_at,
        valid_from, superseded_at, superseded_by, forgotten_at, prev_hash, entry_hash, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id, entry.type, entry.content, entry.scope, entry.source, entry.source_model,
        entry.confidence, entry.created_at, entry.valid_from, entry.superseded_at,
        entry.superseded_by, entry.forgotten_at, entry.prev_hash, entry.entry_hash, entry.metadata,
      ],
    );
    wasmDb.run("UPDATE vault_meta SET value = ? WHERE key = 'chain_head'", [entry.entry_hash]);
    const mutatedImage = Buffer.from(wasmDb.export());
    wasmDb.close();

    // Re-encrypt through the mobile provider: same salt/kdf, fresh nonce,
    // rebuilt header as AAD — exactly what save() does on device.
    const freshKey = deriveMasterKey(
      PASSPHRASE,
      deviceSecret,
      header.salt,
      { opslimit: header.opslimit, memlimit: header.memlimit },
      wasmKdfMobile,
    );
    const newNonce = wasmKdfMobile.randomBytes(NONCE_BYTES);
    const newHeader = buildHeader(header.salt, header.opslimit, header.memlimit, newNonce);
    const newCiphertext = wasmKdfMobile.aeadEncrypt(mutatedImage, newHeader, newNonce, freshKey);
    const mobileVaultPath = path.join(dir, 'vault-from-mobile.nkv');
    writeFileSync(mobileVaultPath, Buffer.concat([newHeader, newCiphertext]));

    // Desktop opens the phone-written file with passphrase + device secret and
    // the provenance chain verifies — the Spike 1 acceptance, in-process.
    const reopened = Vault.open({
      path: mobileVaultPath,
      passphrase: PASSPHRASE,
      deviceSecret,
      platform: nodePlatform(),
    });
    const contents = reopened.list({}).map((e) => e.content);
    expect(contents).toContain('added from the mobile wasm path');
    expect(contents).toHaveLength(3);
    expect(reopened.verifyChain()).toEqual({ ok: true });
    reopened.close();
  });

  it.skipIf(!nodeArgon2Available)(
    'the quick-crypto KDF path (node:crypto.argon2Sync) also decrypts the desktop .nkv to the same rows',
    () => {
      const viaWasm = mobileDecryptVault(fileBytes, wasmKdfMobile);
      const viaQuickCrypto = mobileDecryptVault(fileBytes, mobile);
      // Both KDF backends derive the same master key, so the decrypted images
      // are byte-identical.
      expect(viaQuickCrypto.image.equals(viaWasm.image)).toBe(true);
      const db = new SQL.Database(viaQuickCrypto.image);
      const rows = sqlJsRows(db);
      db.close();
      expect(rows.map((r) => r[0])).toEqual(rememberedIds);
    },
  );
});

describe('expo-sqlite param translation (pure adapter logic)', () => {
  it('passes positional params through untouched', () => {
    expect(toExpoBindParams(['a', 2, null])).toEqual(['a', 2, null]);
  });

  it('re-keys the better-sqlite3 named-object form with the @ prefix', () => {
    expect(toExpoBindParams([{ id: 'x', content: 'y' }])).toEqual([{ '@id': 'x', '@content': 'y' }]);
  });

  it('treats a single Buffer/blob or null argument as positional', () => {
    const blob = Buffer.from([1, 2, 3]);
    expect(isNamedParamsObject([blob])).toBe(false);
    expect(toExpoBindParams([blob])).toEqual([blob]);
    expect(isNamedParamsObject([null])).toBe(false);
    expect(toExpoBindParams([null])).toEqual([null]);
  });

  it('the @-prefixed named form actually binds against a real SQLite engine (sql.js)', () => {
    // Proves the translated bind object works with SQLite name binding
    // generically. NOTE: this uses sql.js, not expo-sqlite; the expo binding
    // itself remains device-unvalidated glue (ADR 0021).
    const db = new SQL.Database();
    db.run('CREATE TABLE t (id TEXT PRIMARY KEY, content TEXT)');
    const [bound] = toExpoBindParams([{ id: 'k1', content: 'hello' }]) as [Record<string, unknown>];
    const stmt = db.prepare('INSERT INTO t (id, content) VALUES (@id, @content)');
    stmt.run(bound);
    stmt.free();
    const rows = db.exec('SELECT id, content FROM t');
    db.close();
    expect(rows[0]!.values).toEqual([['k1', 'hello']]);
  });
});

describe('device secret wire format (QR link / SecureStore)', () => {
  it('round-trips desktop hex encoding exactly', () => {
    const hex = encodeDeviceSecretHex(deviceSecret);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(parseDeviceSecretHex(hex).equals(deviceSecret)).toBe(true);
    expect(parseDeviceSecretHex(`  ${hex.toUpperCase()}\n`).equals(deviceSecret)).toBe(true);
  });

  it('rejects malformed secrets with the desktop rules', () => {
    expect(() => parseDeviceSecretHex('abc')).toThrow(/64 hex/);
    expect(() => parseDeviceSecretHex('zz'.repeat(32))).toThrow(/64 hex/);
    expect(() => encodeDeviceSecretHex(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});
