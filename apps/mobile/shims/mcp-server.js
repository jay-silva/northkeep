/**
 * @northkeep/mcp-server shim for Metro.
 *
 * @northkeep/converse's turn.ts imports one value from this package —
 * `appendCallLog` — as the DEFAULT audit sink. The real package pulls in
 * @northkeep/platform-node -> better-sqlite3 / sodium-native (native Node
 * addons Metro cannot bundle), plus @modelcontextprotocol/sdk. Mapping the
 * whole package to this stub cuts that subtree at the top: Metro never
 * descends into platform-node.
 *
 * The append-only call log is a desktop/CLI artifact written to ~/.northkeep
 * over node:fs; the phone has no such file. The mobile Converse path injects
 * its own in-memory auditFn into runTurn, so this no-op is never actually the
 * sink — it exists only to satisfy the static import so the bundle resolves.
 * If a future code path ever calls it, it is a harmless no-op (never a leak:
 * it receives a content-free CallLogEntry and does nothing with it).
 */
function appendCallLog() {
  // no-op: no call-log file on mobile.
}

module.exports = { appendCallLog };
module.exports.default = module.exports;
