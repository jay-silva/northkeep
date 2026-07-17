/**
 * node:net shim for Metro (see node-fs.js / node-crypto.js for why these exist).
 *
 * @northkeep/converse's provider.ts imports `net` at module top and calls
 * `net.isIP(host)` inside classifyEndpoint() — the ONLY member the converse
 * pipeline touches on device. classifyEndpoint decides whether an endpoint is
 * private (LAN/localhost) or bounded (leaves the device); that classification
 * drives the redaction posture, so this needs REAL behavior, not a throwing
 * stub. isIP is a tiny pure function; the socket/server surface is genuinely
 * unused on the phone and throws loudly if ever reached.
 */

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function isIPv4(input) {
  return typeof input === 'string' && IPV4.test(input);
}

/**
 * Accepts the IPv6 forms classifyEndpoint feeds us (full, `::`-compressed, and
 * IPv4-mapped `::ffff:1.2.3.4`). Requires either eight hex groups or a `::` run
 * so clock-times / random tokens do not read as addresses.
 */
function isIPv6(input) {
  if (typeof input !== 'string' || input.indexOf(':') === -1) return false;
  let head = input.split('%')[0]; // drop zone id
  const lastColon = head.lastIndexOf(':');
  if (lastColon !== -1 && head.slice(lastColon + 1).indexOf('.') !== -1) {
    if (!isIPv4(head.slice(lastColon + 1))) return false;
    head = head.slice(0, lastColon + 1) + '0'; // replace v4 tail with one hex group
  }
  const halves = head.split('::');
  if (halves.length > 2) return false;
  const hexGroup = /^[0-9a-fA-F]{1,4}$/;
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  if (![...left, ...right].every((g) => hexGroup.test(g))) return false;
  if (halves.length === 2) return left.length + right.length <= 7; // `::` fills >= 1 group
  return left.length === 8; // no `::` → exactly eight groups
}

/** Mirrors Node's net.isIP: returns 4, 6, or 0. */
function isIP(input) {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

function unsupported() {
  throw new Error('node:net sockets are unavailable on mobile; only net.isIP is supported.');
}

module.exports = {
  isIP,
  isIPv4,
  isIPv6,
  Socket: unsupported,
  createConnection: unsupported,
  connect: unsupported,
  createServer: unsupported,
};
module.exports.default = module.exports;
