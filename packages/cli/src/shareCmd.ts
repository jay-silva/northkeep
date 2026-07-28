import { loadDeviceSecret, type Vault } from '@northkeep/core';
import {
  deriveConnectorToken,
  deriveSyncCreds,
  downSyncConnector,
  fetchEntitlement,
  foldSidecarScopesIntoVault,
  loadConnectorConfig,
  loadSyncConfig,
  pushSharedScopes,
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
 * The shared-scope list lives IN THE VAULT (ADR 0038), so a mark made here is a
 * mark on every device after the next vault sync. Each command folds a pre-0038
 * sidecar list into the vault first (idempotent), so nothing is silently
 * revoked by upgrading.
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
        "always see this scope's name, how many memories it holds, and when they change. Private scopes are never shared. " +
        'Sharing applies to this scope on EVERY device that syncs this vault, and so does unsharing.',
    );
    const answer = await promptLine('Continue? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) fail('Cancelled. Nothing was shared.');
  }

  const entitlement = await maybeEntitlement(deviceSecret);
  const result = await withVault(async (vault) => {
    foldSidecarScopesIntoVault(vault);
    const wasShared = vault.sharedScopes().includes(scope);
    vault.setScopeShared(scope, true);
    vault.save();
    try {
      return await pushSharedScopes({ server: cfg.server, deviceSecret, scopes: vault.sharedScopes(), vault, entitlement });
    } catch (err) {
      // Same rollback rule as the GUI and the phone (review F5/F1): a scope the
      // server never accepted must not stay marked — the mark would sync to
      // every device as a phantom SHARED badge. But never unmark a scope that
      // was already shared before this call; its server rows are real.
      const msg = err instanceof Error ? err.message : String(err);
      if (!wasShared) {
        vault.setScopeShared(scope, false);
        vault.save();
        throw new Error(`Sharing failed — the mark was rolled back, nothing is shared: ${msg}`);
      }
      throw new Error(`Push failed — '${scope}' stays Shared (it already was): ${msg}`);
    }
  }).catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
  });
  console.log(
    `✓ Scope '${scope}' is now Shared. Pushed ${result.pushed} memories across ${result.scopes.length} shared scope(s).`,
  );
  console.log('  Connect an AI app: northkeep share code');
}

export async function sharePushCmd(withVault: WithVault, fail: (m: string) => never): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  const entitlement = await maybeEntitlement(deviceSecret);
  const result = await withVault((vault) => {
    foldSidecarScopesIntoVault(vault); // saves the vault itself when it folds
    const scopes = vault.sharedScopes();
    if (scopes.length === 0) return null;
    return pushSharedScopes({ server: cfg.server, deviceSecret, scopes, vault, entitlement });
  });
  if (result === null) {
    console.log('No scopes are shared yet. Run: northkeep share add <scope>');
    return;
  }
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
  const entitlement = await maybeEntitlement(deviceSecret);
  const result = await withVault(async (vault) => {
    foldSidecarScopesIntoVault(vault); // saves the vault itself when it folds
    const scopes = vault.sharedScopes();
    if (scopes.length === 0) return null;
    const down = await downSyncConnector({ server: cfg.server, deviceSecret, vault, entitlement });
    // Re-push so each newly down-synced row is rehashed server-side under its
    // vault id with pending cleared, and any forgotten row is reconciled away.
    const push = await pushSharedScopes({ server: cfg.server, deviceSecret, scopes, vault, entitlement });
    return { down, push };
  });
  if (result === null) {
    console.log('No scopes are shared yet. Run: northkeep share add <scope>');
    return;
  }
  console.log(
    `✓ Down-synced: ${result.down.added} added, ${result.down.forgotten} forgotten, ${result.down.deduped} already present.`,
  );
  console.log(
    `✓ Re-pushed ${result.push.pushed} memories across ${result.push.scopes.length} shared scope(s) to ${cfg.server}.`,
  );
}

export async function shareRemoveCmd(
  scope: string,
  withVault: WithVault,
  fail: (m: string) => never,
): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  let outcome: { deleted: number; wasShared: boolean } | { error: string };
  outcome = await withVault(async (vault) => {
    foldSidecarScopesIntoVault(vault);
    const wasShared = vault.sharedScopes().includes(scope);
    // Server delete FIRST, local unmark second (same ordering as always): a
    // failed delete leaves the mark honestly in place rather than the vault
    // claiming private while the server still holds rows.
    try {
      const { deleted } = await unshareScope({ server: cfg.server, deviceSecret, scope });
      vault.setScopeShared(scope, false);
      vault.save();
      return { deleted, wasShared };
    } catch (err) {
      // Nothing to roll back: the fold-in saves itself, and the unmark never
      // happened — the mark honestly stays until the server delete succeeds.
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  if ('error' in outcome) fail(`Could not unshare on the connector server: ${outcome.error}`);
  if (!outcome.wasShared) {
    console.log(`Scope '${scope}' was not marked shared. Unshared on the server anyway to be safe.`);
  }
  console.log(`✓ Scope '${scope}' unshared. Deleted ${outcome.deleted} memories from the connector server.`);
  console.log('  The unshare reaches your other devices with the next vault sync.');
}

export async function shareStatusCmd(withVault: WithVault): Promise<void> {
  const cfg = loadConnectorConfig();
  if (!cfg) {
    console.log('Sharing is not configured. Run: northkeep share server <url>');
    return;
  }
  console.log(`Connector server: ${cfg.server}`);
  const counts = await withVault((vault) => {
    foldSidecarScopesIntoVault(vault); // saves the vault itself when it folds
    return vault.sharedScopes().map((scope) => ({ scope, count: vault.list({ scope }).length }));
  });
  if (counts.length === 0) {
    console.log('Shared scopes: (none). Everything is private by default.');
    return;
  }
  console.log(
    'Shared scopes (stored encrypted on the connector, no key in its database to read them; the key is rebuilt per request ' +
      "from your app's credential plus a server-side secret, and the AI apps you connect read them in full). " +
      'Marks live in the vault, so they apply on every device that syncs it:',
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
