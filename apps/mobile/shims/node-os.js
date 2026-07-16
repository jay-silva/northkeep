/**
 * node:os shim for Metro (see node-fs.js for why these exist). northkeepHome()
 * in @northkeep/core calls os.homedir() but the mobile app never uses the
 * Node home-directory layout; the vault path comes from src/lib/paths.ts.
 */
function homedir() {
  throw new Error('node:os.homedir is not available on mobile. Use src/lib/paths.ts.');
}
function tmpdir() {
  throw new Error('node:os.tmpdir is not available on mobile.');
}

module.exports = { homedir, tmpdir };
module.exports.default = module.exports;
