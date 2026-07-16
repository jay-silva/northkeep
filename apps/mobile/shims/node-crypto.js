/**
 * node:crypto shim for Metro (see node-fs.js for why these exist).
 * @northkeep/sync's creds.ts imports createHash at module top level, but only
 * tokenHash() calls it, and tokenHash is server-side (the server hashes the
 * bearer token; the phone never needs to). deriveSyncCreds, the function the
 * app DOES use, goes through the platform seam's BLAKE2b. If anything on the
 * phone ever reaches createHash, fail loudly rather than hash wrongly.
 */
function createHash() {
  throw new Error(
    'node:crypto.createHash is not available on mobile. tokenHash() is server-side only; ' +
      'client hashing goes through getPlatform().crypto.',
  );
}

module.exports = { createHash };
module.exports.default = module.exports;
