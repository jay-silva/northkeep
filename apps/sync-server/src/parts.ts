/**
 * Sizes and retention for syncing a vault in parts (ADR 0078). PART_BYTES is a
 * multiple of 3, so parts stored as base64 text concatenate into one valid
 * base64 string if the blob ever has to be rebuilt in a single row.
 */

export const PART_BYTES = 3 * 1024 * 1024;
/** Fixed per-request body ceiling, separate from the configurable cap. */
export const SINGLE_REQUEST_MAX = 4 * 1024 * 1024;
export const DEFAULT_CAP_BYTES = 32 * 1024 * 1024;
/** An upload left open this long is abandoned. */
export const OPEN_UPLOAD_TTL_MS = 60 * 60 * 1000;
/** A superseded version stays readable this long, so a slow pull can finish. */
export const SUPERSEDED_READABLE_MS = 10 * 60 * 1000;
export const SUPERSEDED_KEEP_MAX = 3;

export function maxParts(capBytes: number): number {
  return Math.ceil(capBytes / PART_BYTES);
}

/** NORTHKEEP_SYNC_MAX_BYTES, bounded to what one part table can serve. */
export function capFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CAP_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < SINGLE_REQUEST_MAX) return DEFAULT_CAP_BYTES;
  return Math.min(n, 256 * 1024 * 1024);
}

export const UPLOAD_ID_PATTERN = /^[0-9a-f]{32}$/;
