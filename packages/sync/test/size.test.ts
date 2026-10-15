import { describe, expect, it } from 'vitest';
import { MAX_BLOB_BYTES, SIZE_WARNING_BYTES, describeVaultSize, vaultSizeReport } from '../src/index.js';

describe('vault size report (ADR 0067 D4)', () => {
  it('uses the 4 MiB binary cap and warns from 3,145,728 bytes', () => {
    expect(MAX_BLOB_BYTES).toBe(4_194_304);
    expect(SIZE_WARNING_BYTES).toBe(3_145_728);
    expect(vaultSizeReport(3_145_727)).toEqual({ bytes: 3_145_727, cap_bytes: 4_194_304, percent: 74, warning: false, over_cap: false });
    expect(vaultSizeReport(3_145_728)).toMatchObject({ percent: 75, warning: true, over_cap: false });
    expect(vaultSizeReport(4_194_304)).toMatchObject({ percent: 100, warning: true, over_cap: false });
    expect(vaultSizeReport(4_194_305)).toMatchObject({ percent: 100, warning: true, over_cap: true });
  });

  it('describes the size in plain words, saying more only when it matters', () => {
    expect(describeVaultSize(vaultSizeReport(370_000))).toEqual(['Vault size: 362 KB of the 4.0 MB sync limit (8%).']);
    expect(describeVaultSize(vaultSizeReport(3_300_000))).toEqual([
      'Vault size: 3.1 MB of the 4.0 MB sync limit (78%).',
      'Warning: the vault is over 75% of the sync limit.',
    ]);
    expect(describeVaultSize(vaultSizeReport(5_242_880))).toEqual([
      'Vault size: 5.0 MB of the 4.0 MB sync limit (125%).',
      'Over the sync limit: pushes are refused until the vault is smaller.',
    ]);
  });
});
