import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';

/**
 * Connector sharing config sidecar (`~/.northkeep/connector.json`, 0600 like
 * sync.json). Holds only WHERE the connector server is and WHICH scopes the user
 * marked Shared — never a secret (the connector token is re-derived from
 * `device.secret` on demand, ADR 0019).
 *
 * C2 uses a sidecar deliberately. The plan's longer-term refinement is to keep
 * the shared-scope list inside the encrypted vault so it follows the vault
 * through sync across machines; that would touch the vault SQLite image and the
 * invariant-#4 export surface, so it is deferred past C2. The sidecar avoids a
 * memory-schema change while keeping the same 0700-dir / 0600-file posture as
 * the sync sidecar.
 */

export interface ConnectorConfig {
  /** Connector server base URL (https, or loopback for tests). */
  server: string;
  /** Scopes the user has explicitly marked Shared. Default private → empty. */
  sharedScopes: string[];
}

export function connectorConfigPath(): string {
  return path.join(northkeepHome(), 'connector.json');
}

export function loadConnectorConfig(): ConnectorConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(connectorConfigPath(), 'utf8')) as ConnectorConfig;
    if (typeof parsed.server !== 'string') return null;
    const scopes = Array.isArray(parsed.sharedScopes)
      ? parsed.sharedScopes.filter((s): s is string => typeof s === 'string')
      : [];
    // Dedupe + sort so the file is stable and a scope can't be listed twice.
    return { server: parsed.server, sharedScopes: [...new Set(scopes)].sort() };
  } catch {
    return null;
  }
}

export function saveConnectorConfig(config: ConnectorConfig): void {
  const target = connectorConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const clean: ConnectorConfig = {
    server: config.server,
    sharedScopes: [...new Set(config.sharedScopes)].sort(),
  };
  fs.writeFileSync(target, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
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

/** Set (or change) the connector server, keeping any already-shared scopes. */
export function setConnectorServer(serverUrl: string): ConnectorConfig {
  const url = assertConnectorUrl(serverUrl);
  const existing = loadConnectorConfig();
  const config: ConnectorConfig = {
    server: url.toString().replace(/\/$/, ''),
    sharedScopes: existing?.sharedScopes ?? [],
  };
  saveConnectorConfig(config);
  return config;
}

/** Add a scope to the shared list (idempotent). Requires a server already set. */
export function addSharedScope(scope: string): ConnectorConfig {
  const existing = loadConnectorConfig();
  if (!existing) {
    throw new Error('No connector server configured. Run: northkeep share server <url>');
  }
  const config: ConnectorConfig = {
    server: existing.server,
    sharedScopes: [...new Set([...existing.sharedScopes, scope])],
  };
  saveConnectorConfig(config);
  return config;
}

/** Remove a scope from the shared list (idempotent). */
export function removeSharedScope(scope: string): ConnectorConfig {
  const existing = loadConnectorConfig();
  if (!existing) {
    throw new Error('No connector server configured. Run: northkeep share server <url>');
  }
  const config: ConnectorConfig = {
    server: existing.server,
    sharedScopes: existing.sharedScopes.filter((s) => s !== scope),
  };
  saveConnectorConfig(config);
  return config;
}
