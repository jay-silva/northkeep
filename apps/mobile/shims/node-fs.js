/**
 * node:fs shim for Metro. @northkeep/core (platform.ts, lock.ts) and
 * @northkeep/sync (config.ts, client.ts) import node:fs at module top level;
 * the mobile app never calls those functions (vault storage goes through the
 * platform seam, sync config lives in SecureStore, and the pull transport is
 * src/lib/sync.ts). Every member throws so an accidental call fails loudly
 * instead of corrupting anything.
 */
function unavailable(name) {
  return () => {
    throw new Error(
      `node:fs.${name} is not available on mobile. This code path is Node-only; ` +
        'use the platform seam (getPlatform().storage) or the mobile modules instead.',
    );
  };
}

const fns = [
  'existsSync',
  'readFileSync',
  'writeFileSync',
  'mkdirSync',
  'renameSync',
  'copyFileSync',
  'rmSync',
  'unlinkSync',
  'openSync',
  'closeSync',
  'fsyncSync',
  'mkdtempSync',
  'statSync',
  'readdirSync',
];

const shim = {};
for (const name of fns) shim[name] = unavailable(name);

module.exports = shim;
module.exports.default = shim;
