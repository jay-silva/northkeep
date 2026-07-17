/**
 * node:child_process shim for Metro (see node-fs.js for why these exist).
 *
 * @northkeep/importers' chatgpt.js imports execFileSync at module top to shell
 * out during a DESKTOP ChatGPT-export file import. It reaches the phone only as
 * a transitive dependency of the Converse pipeline (converse -> redact/librarian
 * -> importers); the phone never imports a local file this way, so this path is
 * never called. Fail loudly if it ever is, rather than silently doing nothing.
 */
function execFileSync() {
  throw new Error('node:child_process is not available on mobile (desktop file-import path only).');
}

function execSync() {
  throw new Error('node:child_process is not available on mobile (desktop file-import path only).');
}

function spawn() {
  throw new Error('node:child_process is not available on mobile (desktop file-import path only).');
}

module.exports = { execFileSync, execSync, spawn };
module.exports.default = module.exports;
