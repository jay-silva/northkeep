/**
 * ADR 0067 D4: how full the vault file is against the whole-file sync cap.
 * Pure arithmetic on a byte count, so the phone can use it too; nothing here
 * reads a file or touches the network.
 */

/** Hosted body limit is 4.5 MB (Vercel); the server mirrors this cap. */
export const MAX_BLOB_BYTES = 4 * 1024 * 1024;

/** Warn at 75% of the cap: 3,145,728 bytes. */
export const SIZE_WARNING_BYTES = (MAX_BLOB_BYTES * 3) / 4;

export interface VaultSizeReport {
  bytes: number;
  cap_bytes: number;
  /** Whole percent of the cap, rounded down so 74.9% never reads as 75%. */
  percent: number;
  /** At or over 75% of the cap. */
  warning: boolean;
  /** Over the cap: a push is refused. */
  over_cap: boolean;
}

export function vaultSizeReport(bytes: number): VaultSizeReport {
  return {
    bytes,
    cap_bytes: MAX_BLOB_BYTES,
    percent: Math.floor((bytes * 100) / MAX_BLOB_BYTES),
    warning: bytes >= SIZE_WARNING_BYTES,
    over_cap: bytes > MAX_BLOB_BYTES,
  };
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Plain lines for a terminal or an error message; the caller adds its own remedy. */
export function describeVaultSize(report: VaultSizeReport): string[] {
  const lines = [`Vault size: ${formatBytes(report.bytes)} of the ${formatBytes(report.cap_bytes)} sync limit (${report.percent}%).`];
  if (report.over_cap) lines.push('Over the sync limit: pushes are refused until the vault is smaller.');
  else if (report.warning) lines.push('Warning: the vault is over 75% of the sync limit.');
  return lines;
}
