/**
 * node:path shim for Metro (see node-fs.js for why these exist). join and
 * dirname get real (POSIX-only) implementations because they are pure string
 * work and harmless; anything filesystem-shaped stays unimplemented.
 */
function join(...parts) {
  return parts
    .filter((p) => typeof p === 'string' && p.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

function dirname(p) {
  const idx = String(p).replace(/\/+$/, '').lastIndexOf('/');
  return idx <= 0 ? '/' : String(p).slice(0, idx);
}

function basename(p) {
  const cleaned = String(p).replace(/\/+$/, '');
  return cleaned.slice(cleaned.lastIndexOf('/') + 1);
}

module.exports = { join, dirname, basename, sep: '/', posix: { join, dirname, basename } };
module.exports.default = module.exports;
