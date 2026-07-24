import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KDF_INTERACTIVE, MEMORY_TYPES, Vault, generateDeviceSecret } from '@northkeep/core';
import { DEMO_MEMORIES, DEMO_PASSPHRASE } from '../src/lib/demo-vault.js';

/**
 * The demo seed (M6-2b) is data that gets fed straight into core's
 * Vault.remember at runtime, so a bad type or empty content would throw only on
 * device. These tests catch that here, and prove the seed builds a real,
 * decryptable vault through the SAME core path startDemo drives (Vault.create ->
 * remember -> save -> reopen). The Node platform stands in for the mobile
 * platform seam; both implement the identical adapter interface.
 */
describe('demo vault seed', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('uses only valid memory types and non-empty synthetic content', () => {
    expect(DEMO_MEMORIES.length).toBeGreaterThan(0);
    for (const memory of DEMO_MEMORIES) {
      expect(MEMORY_TYPES).toContain(memory.type);
      expect(memory.content.trim().length).toBeGreaterThan(0);
      // Synthetic-only: the demo must never ship a real-looking credential.
      expect(memory.source).toBe('demo');
    }
  });

  it('builds a real, decryptable vault from the seed (same core path as startDemo)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nk-demo-'));
    dirs.push(dir);
    const path = join(dir, 'demo.nkv');
    const secret = generateDeviceSecret();

    const vault = Vault.create({
      path,
      passphrase: DEMO_PASSPHRASE,
      deviceSecret: Buffer.from(secret),
      kdf: KDF_INTERACTIVE,
    });
    for (const memory of DEMO_MEMORIES) vault.remember(memory);
    vault.save();
    vault.close();

    // Reopen with the same two secrets to prove it is a valid encrypted vault.
    const reopened = Vault.open({ path, passphrase: DEMO_PASSPHRASE, deviceSecret: Buffer.from(secret) });
    expect(reopened.list().length).toBe(DEMO_MEMORIES.length);
    reopened.close();
  });
});
