/**
 * Local stand-in for core's MirrorFile (ADR 0053), declared identically so the
 * swap to `@northkeep/core` is a one-line import change once core lands.
 */
export interface MirrorFile {
  path: string;
  bytes: Uint8Array;
  slug: string | null;
  kind: 'document' | 'log' | 'index';
  revision: string | null;
}
