import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome, type Vault } from '@northkeep/core';

/**
 * Connector config sidecar (`~/.northkeep/connector.json`, 0600 like
 * sync.json). Holds only WHERE the connector server is — never a secret (the
 * connector token is re-derived from `device.secret` on demand, ADR 0019).
 *
 * The shared-scope list used to live here too (C2). ADR 0038 moved it into the
 * encrypted vault's `scopes` table so the marks travel with the vault through
 * sync and every device answers "what is shared?" identically. The server URL
 * stays in the sidecar because it is genuinely per-device configuration (a
 * self-hoster may point one machine at a different connector).
 * `foldSidecarScopesIntoVault` migrates a pre-0038 sidecar's list into the
 * vault once, then strips it from the file.
 */

export interface ConnectorConfig {
  /** Connector server base URL (https, or loopback for tests). */
  server: string;
}

export function connectorConfigPath(): string {
  return path.join(northkeepHome(), 'connector.json');
}

export function loadConnectorConfig(): ConnectorConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(connectorConfigPath(), 'utf8')) as { server?: unknown };
    if (typeof parsed.server !== 'string') return null;
    return { server: parsed.server };
  } catch {
    return null;
  }
}

export function saveConnectorConfig(config: ConnectorConfig): void {
  const target = connectorConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify({ server: config.server }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * One-time migration (ADR 0038): move a pre-0038 sidecar's `sharedScopes` list
 * into the vault, then rewrite the sidecar without it. Idempotent — a sidecar
 * with no `sharedScopes` key is a no-op — and additive only: it can mark a
 * scope shared in the vault, never unmark one, so it cannot revoke a share made
 * elsewhere.
 *
 * ORDER IS LOAD-BEARING (review F4): the vault is SAVED before the sidecar key
 * is stripped. A crash between the two leaves both copies present, and the next
 * run refolds — an additive no-op. Stripping first risked the reverse: legacy
 * list gone, vault never saved, shares silently lost.
 *
 * Every share path calls this before reading `vault.sharedScopes()`, so a user
 * upgrading mid-flight keeps their existing shares without silent revocation.
 */
export function foldSidecarScopesIntoVault(vault: Vault): { folded: string[] } {
  let raw: { sharedScopes?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(connectorConfigPath(), 'utf8')) as { sharedScopes?: unknown };
  } catch {
    return { folded: [] };
  }
  if (!Array.isArray(raw.sharedScopes)) return { folded: [] };
  const scopes = [...new Set(raw.sharedScopes.filter((s): s is string => typeof s === 'string' && s.trim() !== ''))].sort();
  if (scopes.length > 0) {
    for (const scope of scopes) vault.setScopeShared(scope, true);
    vault.save();
  }
  // Strip the key so the fold-in never runs again — a stale sidecar list
  // re-asserting itself later could resurrect a share the user has since
  // revoked on another device.
  const rest = { ...(raw as Record<string, unknown>) };
  delete rest.sharedScopes;
  fs.writeFileSync(connectorConfigPath(), `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 });
  return { folded: scopes };
}

/**
 * Refuse a non-https connector server unless it's loopback (tests / self-host).
 * Same stance as the sync sidecar: the connector token must never cross the
 * network in the clear.
 */
export function assertConnectorUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid connector server URL: "${rawUrl}"`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && loopback) return url;
  throw new Error(
    `Refusing a non-https connector server ("${rawUrl}"). Use https:// so your connector token never crosses the network unprotected.`,
  );
}

/**
 * Set (or change) the connector server. A pre-0038 sidecar's sharedScopes key
 * is preserved verbatim until foldSidecarScopesIntoVault runs — rewriting it
 * away here would silently drop shares before they reach the vault.
 */
export function setConnectorServer(serverUrl: string): ConnectorConfig {
  const url = assertConnectorUrl(serverUrl);
  const server = url.toString().replace(/\/$/, '');
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(connectorConfigPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    // No existing file — start fresh.
  }
  const target = connectorConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify({ ...raw, server }, null, 2)}\n`, { mode: 0o600 });
  return { server };
}
