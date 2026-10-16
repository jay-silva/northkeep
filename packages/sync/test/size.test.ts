import { describe, expect, it } from 'vitest';
import {
  MAX_BLOB_BYTES,
  SINGLE_REQUEST_MAX,
  SIZE_WARNING_BYTES,
  describeVaultSize,
  effectiveCap,
  vaultSizeReport,
} from '../src/index.js';

const MiB = 1024 * 1024;

describe('vault size report (ADR 0067 D4, ADR 0078 D2)', () => {
  it('has a 32 MiB ceiling, a 4 MiB single request, and warns at 75%', () => {
    expect(MAX_BLOB_BYTES).toBe(33_554_432);
    expect(SINGLE_REQUEST_MAX).toBe(4_194_304);
    expect(SIZE_WARNING_BYTES).toBe(25_165_824);
    expect(vaultSizeReport(SIZE_WARNING_BYTES - 1)).toEqual({
      bytes: SIZE_WARNING_BYTES - 1,
      cap_bytes: MAX_BLOB_BYTES,
      percent: 74,
      warning: false,
      over_cap: false,
      over_single_request: true,
    });
    expect(vaultSizeReport(SIZE_WARNING_BYTES)).toMatchObject({ percent: 75, warning: true, over_cap: false });
    expect(vaultSizeReport(MAX_BLOB_BYTES + 1)).toMatchObject({ percent: 100, warning: true, over_cap: true });
  });

  it('takes the server cap but never above this build ceiling', () => {
    expect(effectiveCap(undefined)).toBe(SINGLE_REQUEST_MAX);
    expect(effectiveCap('32')).toBe(SINGLE_REQUEST_MAX);
    expect(effectiveCap(-1)).toBe(SINGLE_REQUEST_MAX);
    expect(effectiveCap(16 * MiB)).toBe(16 * MiB);
    expect(effectiveCap(256 * MiB)).toBe(MAX_BLOB_BYTES);
    expect(vaultSizeReport(1, 256 * MiB).cap_bytes).toBe(MAX_BLOB_BYTES);
  });

  it('against an old 4 MiB server, keeps the old thresholds', () => {
    const cap = effectiveCap(undefined);
    expect(vaultSizeReport(3_145_727, cap)).toMatchObject({ percent: 74, warning: false });
    expect(vaultSizeReport(3_145_728, cap)).toMatchObject({ percent: 75, warning: true });
    expect(vaultSizeReport(4_194_305, cap)).toMatchObject({ over_cap: true, over_single_request: true });
    expect(describeVaultSize(vaultSizeReport(3_145_728, cap))).toEqual([
      'Vault size: 3 MB of the 4 MB sync limit (75%).',
      'Warning: the vault is at or over 75% of the sync limit.',
    ]);
  });

  it('describes the size in plain words, saying more only when it matters', () => {
    expect(describeVaultSize(vaultSizeReport(370_000))).toEqual(['Vault size: 362 KB of the 32 MB sync limit (1%).']);
    expect(describeVaultSize(vaultSizeReport(5 * MiB))).toEqual([
      'Vault size: 5 MB of the 32 MB sync limit (15%).',
      'Over 4 MB: your other devices need the latest NorthKeep to keep syncing.',
    ]);
    expect(describeVaultSize(vaultSizeReport(30 * MiB))).toEqual([
      'Vault size: 30 MB of the 32 MB sync limit (93%).',
      'Warning: the vault is at or over 75% of the sync limit.',
      'Over 4 MB: your other devices need the latest NorthKeep to keep syncing.',
    ]);
    expect(describeVaultSize(vaultSizeReport(40 * MiB))).toEqual([
      'Vault size: 40 MB of the 32 MB sync limit (125%).',
      'Over the sync limit: pushes are refused until the vault is smaller.',
    ]);
  });
});
