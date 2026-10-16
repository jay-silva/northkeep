/**
 * ADR 0067 D4: how full the vault file is against the whole-file sync cap.
 * Pure arithmetic on a byte count, so the phone can use it too; nothing here
 * reads a file or touches the network.
 */

/** Largest vault one request carries (Vercel refuses bodies over 4.5 MB); bigger ones sync in parts (ADR 0078). */
export const SINGLE_REQUEST_MAX = 4 * 1024 * 1024;

/** This build's ceiling: a server may set a lower cap, never a higher one (ADR 0078 D2). */
export const MAX_BLOB_BYTES = 32 * 1024 * 1024;

/** Warn at 75% of the ceiling. */
export const SIZE_WARNING_BYTES = (MAX_BLOB_BYTES * 3) / 4;

/**
 * The cap that applies on a server. A server that reports none predates
 * parts sync, so only a single request fits.
 */
export function effectiveCap(serverCap: unknown): number {
  if (typeof serverCap !== 'number' || !Number.isInteger(serverCap) || serverCap <= 0) return SINGLE_REQUEST_MAX;
  return Math.min(serverCap, MAX_BLOB_BYTES);
}

export interface VaultSizeReport {
  bytes: number;
  cap_bytes: number;
  /** Whole percent of the cap, rounded down so 74.9% never reads as 75%. */
  percent: number;
  /** At or over 75% of the cap. */
  warning: boolean;
  /** Over the cap: a push is refused. */
  over_cap: boolean;
  /** Over 4 MB: devices on builds before ADR 0078 stop syncing this vault. */
  over_single_request: boolean;
}

export function vaultSizeReport(bytes: number, capBytes: number = MAX_BLOB_BYTES): VaultSizeReport {
  const cap = Math.min(capBytes, MAX_BLOB_BYTES);
  return {
    bytes,
    cap_bytes: cap,
    percent: Math.floor((bytes * 100) / cap),
    warning: bytes * 4 >= cap * 3,
    over_cap: bytes > cap,
    over_single_request: bytes > SINGLE_REQUEST_MAX,
  };
}

/** One unit everywhere: binary KB and MB (1 MB = 1,048,576 bytes), so the cap reads "4 MB". */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  const mb = bytes / 1024 / 1024;
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

/** Plain lines for a terminal or an error message; the caller adds its own remedy. */
export function describeVaultSize(report: VaultSizeReport): string[] {
  const lines = [`Vault size: ${formatBytes(report.bytes)} of the ${formatBytes(report.cap_bytes)} sync limit (${report.percent}%).`];
  if (report.over_cap) lines.push('Over the sync limit: pushes are refused until the vault is smaller.');
  else if (report.warning) lines.push('Warning: the vault is at or over 75% of the sync limit.');
  if (report.over_single_request && !report.over_cap) {
    lines.push('Over 4 MB: your other devices need the latest NorthKeep to keep syncing.');
  }
  return lines;
}
