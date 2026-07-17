import { loadDeviceSecret, type Vault } from '@northkeep/core';
import {
  addSharedScope,
  deriveConnectorToken,
  deriveSyncCreds,
  downSyncConnector,
  fetchEntitlement,
  loadConnectorConfig,
  loadSyncConfig,
  pushSharedScopes,
  removeSharedScope,
  setConnectorServer,
  startPairing,
  tokenHash,
  unshareScope,
  type ConnectorConfig,
} from '@northkeep/sync';
import { promptLine } from './prompt.js';

/**
 * `northkeep share` — mark scopes Shared and push the REAL vault entries in those
 * scopes to the hosted connector (ADR 0019, phase C2). Private is the default;
 * sharing is per-scope, loudly confirmed, and reversible with server-side
 * deletion.
 *
 * `withVault` is injected by the CLI (index.ts) so these functions reuse the one
 * vault-open path (Keychain/env key, else passphrase) and stay unit-testable
 * with a cheap-KDF vault.
 */

export type WithVault = <T>(fn: (vault: Vault) => Promise<T> | T) => Promise<T>;

function deviceSecretOrFail(fail: (m: string) => never): Buffer {
  try {
    return loadDeviceSecret();
  } catch {
    fail('No device secret found. Run "northkeep init" first.');
  }
}

function requireConfig(fail: (m: string) => never): ConnectorConfig {
  const cfg = loadConnectorConfig();
  if (!cfg) fail('No connector server configured. Run: northkeep share server <url>');
  return cfg;
}

/**
 * Best-effort entitlement attestation for the connector's billing gate: if a
 * sync server is configured, fetch an anonymous "active subscriber" token to
 * forward. Never blocks sharing — a self-hosted / ungated connector needs none,
 * and a truly gated one returns a clear 402 that surfaces on the actual request.
 */
async function maybeEntitlement(deviceSecret: Buffer): Promise<string | undefined> {
  const sync = loadSyncConfig();
  if (!sync) return undefined;
  try {
    const { token } = deriveSyncCreds(deviceSecret);
    return (await fetchEntitlement({ syncServer: sync.serverUrl, syncToken: token })) ?? undefined;
  } catch {
    return undefined;
  }
}

export function shareServerCmd(url: string, fail: (m: string) => never): void {
  let cfg;
  try {
    cfg = setConnectorServer(url);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`✓ Connector server set: ${cfg.server}`);
  console.log('  Next: "northkeep share add <scope>" to share a scope, then "northkeep share code" to connect an AI app.');
}

export async function shareAddCmd(
  scope: string,
  options: { yes?: boolean },
  withVault: WithVault,
  fail: (m: string) => never,
): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);

  const assumeYes = options.yes === true || process.env.NORTHKEEP_ASSUME_YES === '1';
  if (!assumeYes) {
    console.log(
      `Memories in '${scope}' will be copied to NorthKeep's connector server, where the AI apps you connect read them IN FULL. ` +
        'They are stored encrypted at rest; the connector database holds no key that can read them, but the server rebuilds ' +
        "the key each request from your app's credential plus a secret it holds and briefly decrypts them to answer. It can " +
        "always see this scope's name, how many memories it holds, and when they change. Private scopes are never shared.",
    );
    const answer = await promptLine('Continue? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) fail('Cancelled. Nothing was shared.');
  }

  const updated = addSharedScope(scope);
  const entitlement = await maybeEntitlement(deviceSecret);
  const result = await withVault((vault) =>
    pushSharedScopes({ server: updated.server, deviceSecret, scopes: updated.sharedScopes, vault, entitlement }),
  );
  console.log(
    `✓ Scope '${scope}' is now Shared. Pushed ${result.pushed} memories across ${result.scopes.length} shared scope(s).`,
  );
  console.log('  Connect an AI app: northkeep share code');
}

export async function sharePushCmd(withVault: WithVault, fail: (m: string) => never): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  if (cfg.sharedScopes.length === 0) {
    console.log('No scopes are shared yet. Run: northkeep share add <scope>');
    return;
  }
  const entitlement = await maybeEntitlement(deviceSecret);
  const result = await withVault((vault) =>
    pushSharedScopes({ server: cfg.server, deviceSecret, scopes: cfg.sharedScopes, vault, entitlement }),
  );
  console.log(
    `✓ Pushed ${result.pushed} memories across ${result.scopes.length} shared scope(s) to ${cfg.server}.`,
  );
}

/**
 * `northkeep share sync` — pull memories/forgets created inside the AI apps back
 * into the vault (down-sync), then re-push so the server's rows match the vault
 * (ADR 0019, phase C3). One vault-open path handles both, so the pushed rows
 * reflect the just-applied down-sync.
 */
export async function shareSyncCmd(withVault: WithVault, fail: (m: string) => never): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  if (cfg.sharedScopes.length === 0) {
    console.log('No scopes are shared yet. Run: northkeep share add <scope>');
    return;
  }
  const entitlement = await maybeEntitlement(deviceSecret);
  const result = await withVault(async (vault) => {
    const down = await downSyncConnector({ server: cfg.server, deviceSecret, vault, entitlement });
    // Re-push so each newly down-synced row is rehashed server-side under its
    // vault id with pending cleared, and any forgotten row is reconciled away.
    const push = await pushSharedScopes({ server: cfg.server, deviceSecret, scopes: cfg.sharedScopes, vault, entitlement });
    return { down, push };
  });
  console.log(
    `✓ Down-synced: ${result.down.added} added, ${result.down.forgotten} forgotten, ${result.down.deduped} already present.`,
  );
  console.log(
    `✓ Re-pushed ${result.push.pushed} memories across ${result.push.scopes.length} shared scope(s) to ${cfg.server}.`,
  );
}

export async function shareRemoveCmd(scope: string, fail: (m: string) => never): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  if (!cfg.sharedScopes.includes(scope)) {
    console.log(`Scope '${scope}' is not currently shared. Unsharing on the server anyway to be safe.`);
  }
  let deleted = 0;
  try {
    ({ deleted } = await unshareScope({ server: cfg.server, deviceSecret, scope }));
  } catch (err) {
    fail(`Could not unshare on the connector server: ${err instanceof Error ? err.message : String(err)}`);
  }
  removeSharedScope(scope);
  console.log(`✓ Scope '${scope}' unshared. Deleted ${deleted} memories from the connector server.`);
}

export async function shareStatusCmd(withVault: WithVault): Promise<void> {
  const cfg = loadConnectorConfig();
  if (!cfg) {
    console.log('Sharing is not configured. Run: northkeep share server <url>');
    return;
  }
  console.log(`Connector server: ${cfg.server}`);
  if (cfg.sharedScopes.length === 0) {
    console.log('Shared scopes: (none). Everything is private by default.');
    return;
  }
  const counts = await withVault((vault) =>
    cfg.sharedScopes.map((scope) => ({ scope, count: vault.list({ scope }).length })),
  );
  console.log(
    'Shared scopes (stored encrypted on the connector, no key in its database to read them; the key is rebuilt per request ' +
      "from your app's credential plus a server-side secret, and the AI apps you connect read them in full):",
  );
  for (const c of counts) console.log(`  ${c.scope} — ${c.count} ${c.count === 1 ? 'memory' : 'memories'}`);
}

/**
 * `northkeep share id` — print the connector account id (sha256 of the connector
 * token). This is the value a connector operator adds to
 * NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES to comp an account (free access,
 * bypassing the subscription gate). It is a one-way hash: it identifies "an
 * account" but reveals nothing about the memories and decrypts nothing. The same
 * device secret on another machine yields the same id.
 */
export function shareIdCmd(fail: (m: string) => never): void {
  const deviceSecret = deviceSecretOrFail(fail);
  const accountHash = tokenHash(deriveConnectorToken(deviceSecret));
  console.log(`Your connector account id: ${accountHash}`);
  console.log('  Give this to the connector operator to be added to the free/comp allowlist.');
  console.log('  It identifies your account but reveals nothing about your memories.');
}

export async function shareCodeCmd(fail: (m: string) => never): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  const entitlement = await maybeEntitlement(deviceSecret);
  let code: string;
  try {
    code = await startPairing({ server: cfg.server, deviceSecret, entitlement });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`Pairing code: ${code}`);
  console.log('');
  console.log('Enter this code when connecting NorthKeep in Claude or ChatGPT.');
  console.log('It expires in 10 minutes and can be used once.');
}
