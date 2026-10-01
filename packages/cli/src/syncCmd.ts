import fs from 'node:fs';
import { Vault, deriveMasterKey, loadDeviceSecret, memzero } from '@northkeep/core';
import { resolveMasterKey } from '@northkeep/mcp-server';
import {
  checkoutUrl,
  confirmPull,
  deriveSyncCreds,
  loadSyncConfig,
  portalUrl,
  previewPull,
  pullVault,
  type PullDropReport,
  pushVault,
  setSyncServer,
  subscriptionStatus,
  SubscriptionRequiredError,
  syncAge,
  syncState,
  tokenHash,
} from '@northkeep/sync';
import { getPassphrase } from './prompt.js';

const SUBSCRIBE_HINT =
  'This sync server requires a $10/month subscription. Run "northkeep sync subscribe" to start one.';

/**
 * `northkeep sync` — client-side-encrypted vault sync (ADR 0009). The vault
 * travels as its own opaque `.nkv` ciphertext blob; the server never gets a
 * key. A second machine needs the SAME `device.secret` (copy it over) plus the
 * passphrase.
 */

function deviceSecretOrFail(fail: (m: string) => never): Buffer {
  try {
    return loadDeviceSecret();
  } catch {
    fail('No device secret found. Run "northkeep init" first (and on a second machine, copy your device.secret over).');
  }
}

export async function syncConfig(
  serverUrl: string,
  fail: (m: string) => never,
): Promise<void> {
  const deviceSecret = deviceSecretOrFail(fail);
  const { accountId } = deriveSyncCreds(deviceSecret);
  const config = setSyncServer(serverUrl, accountId);
  console.log(`✓ Sync server set: ${config.serverUrl}`);
  console.log(`  Your sync id: ${accountId}`);
  console.log('  Next: "northkeep sync push" to upload, or "northkeep sync pull" on another machine.');
}

export async function syncPush(vaultPath: string, fail: (m: string) => never): Promise<void> {
  const deviceSecret = deviceSecretOrFail(fail);
  if (!loadSyncConfig()) fail('Sync is not configured. Run: northkeep sync config --server <url>');
  if (!fs.existsSync(vaultPath)) fail('No local vault to push. Run "northkeep init" first.');

  // Unlock-to-push (ADR 0038 addendum): same key resolution as syncPull.
  let masterKey: Buffer;
  const resolved = resolveMasterKey(vaultPath);
  if (resolved) {
    masterKey = resolved.key;
  } else {
    const passphrase = await getPassphrase('Passphrase (to stamp the vault before push): ');
    const header = Vault.readHeader(vaultPath);
    masterKey = deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf);
  }
  let result: Awaited<ReturnType<typeof pushVault>>;
  try {
    result = await pushVault({ vaultPath, deviceSecret, masterKey });
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) fail(SUBSCRIBE_HINT);
    throw err;
  } finally {
    memzero(masterKey);
  }
  if (result.ok) {
    console.log(`✓ Pushed. Server is now at version ${result.version}.`);
  } else {
    fail(
      `Conflict: the vault changed on another device (server is at version ${result.version}). ` +
        'Run "northkeep sync pull" first, then push again.',
    );
  }
}

/** D6: the manual report, in plain words. `vault.nkv.bak` keeps what drops out. */
export function describeDropReport(report: PullDropReport): string[] {
  const lines: string[] = [];
  if (report.only_here.length > 0) {
    lines.push(`  ${report.only_here.length} ${report.only_here.length === 1 ? 'item is' : 'items are'} only on this device and would be removed:`);
    for (const item of report.only_here) lines.push(`    ${item.scope}: "${item.first_line}"`);
  }
  if (report.projects.length > 0) lines.push(`  Projects whose current version is only on this device: ${report.projects.join(', ')}`);
  if (report.restored_deletes.length > 0) {
    const scopes = [...new Set(report.restored_deletes.map((d) => d.scope))].join(', ');
    lines.push(`  ${report.restored_deletes.length} ${report.restored_deletes.length === 1 ? 'memory' : 'memories'} you deleted here would come back (${scopes})`);
  }
  for (const m of report.scope_marks) {
    lines.push(`  For your information: '${m.scope}' is ${m.shared_here ? 'shared' : 'private'} here and ${m.shared_there ? 'shared' : 'private'} in the copy being pulled.`);
  }
  return lines;
}

export async function syncPull(
  vaultPath: string,
  options: { yes?: boolean },
  fail: (m: string) => never,
  ask: (question: string) => Promise<string | null>,
): Promise<void> {
  const deviceSecret = deviceSecretOrFail(fail);
  if (!loadSyncConfig()) fail('Sync is not configured. Run: northkeep sync config --server <url>');
  const localExists = fs.existsSync(vaultPath);

  try {
    if (!localExists) {
      // A fresh machine has nothing to protect or report.
      const result = await pullVault({ vaultPath, deviceSecret });
      if (!result.ok) fail('Nothing to pull: no vault has been pushed to this sync server yet.');
      console.log(`✓ Pulled version ${result.version}. Your vault is up to date.`);
      console.log('  Open it with your passphrase: northkeep list');
      return;
    }
    // Protect an existing local vault: prove the pulled blob opens with our key
    // BEFORE it replaces the local file, and report what it would drop (D6).
    let masterKey: Buffer;
    const resolved = resolveMasterKey(vaultPath);
    if (resolved) {
      masterKey = resolved.key;
    } else {
      const passphrase = await getPassphrase('Passphrase (to verify the pulled vault): ');
      const header = Vault.readHeader(vaultPath);
      masterKey = deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf);
    }
    try {
      const preview = await previewPull({ vaultPath, deviceSecret, masterKey });
      if (!preview.ok) fail('Nothing to pull: no vault has been pushed to this sync server yet.');
      const described = describeDropReport(preview.report);
      if (preview.wouldDrop) {
        console.log(`The copy on your sync server (version ${preview.version}) would change this device:`);
        for (const line of described) console.log(line);
        console.log('  Your current vault is kept as vault.nkv.bak next to the vault file until the next save overwrites it; copy it first if you may need anything removed.');
        const assumeYes = options.yes === true || process.env.NORTHKEEP_ASSUME_YES === '1';
        if (!assumeYes) {
          const answer = await ask('Replace this vault with the server copy? [y/N] ');
          if (answer === null) fail('This pull would remove or undo something on this device, and there is no terminal to ask on. Nothing was changed. Run again with --yes to pull anyway.');
          if (!/^y(es)?$/i.test(answer.trim())) fail('Cancelled. Nothing was changed.');
        }
      } else {
        for (const line of described) console.log(line);
      }
      const result = await confirmPull({ vaultPath, deviceSecret, masterKey, version: preview.version, sha256: preview.sha256 });
      if (!result.ok) fail('Nothing to pull: no vault has been pushed to this sync server yet.');
      console.log(`✓ Pulled version ${result.version}. Your vault is up to date.`);
    } finally {
      memzero(masterKey);
    }
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) fail(SUBSCRIBE_HINT);
    throw err;
  }
}

export async function syncStatusCmd(vaultPath: string, fail: (m: string) => never): Promise<void> {
  const deviceSecret = deviceSecretOrFail(fail);
  const config = loadSyncConfig();
  if (!config) {
    console.log('Sync is not configured. Run: northkeep sync config --server <url>');
    return;
  }
  const { state, localVersion, remoteVersion, baselineKnown } = await syncState({ vaultPath, deviceSecret });
  console.log(`Server: ${config.serverUrl}`);
  // ADR 0044: staleness is visible even when nothing has failed.
  console.log(`Last synced: ${syncAge(config.lastSyncedAt) ?? 'never'}`);

  // Billing state, when this server bills. A server without Stripe returns a
  // subscription payload that simply reports inactive/none; only mention it when
  // there's something to say.
  try {
    const sub = await subscriptionStatus({ deviceSecret });
    if (sub.active) {
      const until = sub.currentPeriodEnd
        ? ` (renews ${new Date(sub.currentPeriodEnd * 1000).toISOString().slice(0, 10)})`
        : '';
      console.log(`Subscription: ✓ ${sub.status}${until}. Manage it: northkeep sync billing`);
    } else if (sub.status && sub.status !== 'none') {
      console.log(`Subscription: ${sub.status} (inactive). Run: northkeep sync subscribe`);
    } else if (sub.billing) {
      // Billing server, no subscription yet — allowlisted accounts sync free, so
      // this only matters if a push/pull is refused; still, surface the option.
      console.log('Subscription: none. This server bills $10/month. Run: northkeep sync subscribe');
    }
  } catch {
    // Older servers (pre-billing) may not expose /api/subscription; stay quiet.
  }

  // "In sync" means the bytes match, not just that the version numbers line up
  // — see syncState(). Everything else names what to run next.
  const messages: Record<typeof state, string> = {
    'in-sync': '✓ In sync: this vault and the server hold the same bytes.',
    behind: `↓ Behind: the server has newer changes (local v${localVersion}, server v${remoteVersion}). Run: northkeep sync pull`,
    ahead: `↑ Ahead: this vault has changes the server does not have (local v${localVersion}, server v${remoteVersion}). Run: northkeep sync push`,
    // Without a recorded baseline we only know the bytes differ, not that BOTH
    // sides moved — so don't claim they did. The advice is the same either way.
    diverged:
      (baselineKnown
        ? `⚠ Diverged: this vault differs from the server's newer copy (local v${localVersion}, server v${remoteVersion}).\n`
        : `⚠ Diverged: the server has newer changes and this vault may have changed too (local v${localVersion}, server v${remoteVersion}).\n`) +
      '  Pull first (your current vault is kept as vault.nkv.bak), then push:\n' +
      '  northkeep sync pull && northkeep sync push',
    'no-remote': 'No vault has been pushed to the server yet. Run: northkeep sync push',
    'no-local': `No local vault; the server has version ${remoteVersion}. Run: northkeep sync pull`,
    'no-config': 'Sync is not configured.',
  };
  console.log(messages[state]);
}

export async function syncSubscribe(fail: (m: string) => never): Promise<void> {
  const deviceSecret = deviceSecretOrFail(fail);
  if (!loadSyncConfig()) fail('Sync is not configured. Run: northkeep sync config --server <url>');

  // Already covered? Say so instead of opening a second checkout.
  try {
    const sub = await subscriptionStatus({ deviceSecret });
    if (sub.active) {
      console.log(`✓ You already have an active subscription (${sub.status}).`);
      console.log('  Manage or cancel it: northkeep sync billing');
      return;
    }
  } catch {
    // Fall through to checkout; a server that bills will accept the request.
  }

  let url: string;
  try {
    url = await checkoutUrl({ deviceSecret });
  } catch {
    fail('This sync server does not offer subscriptions (it may be private or self-hosted).');
  }
  console.log('Open this link in your browser to subscribe ($10/month, secure Stripe checkout):');
  console.log('');
  console.log(`  ${url}`);
  console.log('');
  console.log('Your card is entered on Stripe; it never touches NorthKeep. After you subscribe,');
  console.log('run "northkeep sync push" to start syncing.');
}

export async function syncBilling(fail: (m: string) => never): Promise<void> {
  const deviceSecret = deviceSecretOrFail(fail);
  if (!loadSyncConfig()) fail('Sync is not configured. Run: northkeep sync config --server <url>');
  let url: string | null;
  try {
    url = await portalUrl({ deviceSecret });
  } catch {
    fail('This sync server does not offer subscriptions (it may be private or self-hosted).');
  }
  if (!url) {
    fail('No subscription found for this account. Start one: northkeep sync subscribe');
  }
  console.log('Open this link to manage your subscription (update card, cancel):');
  console.log('');
  console.log(`  ${url}`);
}

export function syncId(fail: (m: string) => never): void {
  const deviceSecret = deviceSecretOrFail(fail);
  const { accountId, token } = deriveSyncCreds(deviceSecret);
  console.log(`Your sync id: ${accountId}`);
  console.log('This id is derived from your device secret. A second machine with the SAME');
  console.log('device.secret + passphrase gets the same id and can pull your vault.');
  console.log('');
  console.log(`Server allowlist hash: ${tokenHash(token)}`);
  console.log('To run a PRIVATE sync server (until billing), set this on the server:');
  console.log(`  NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES=${tokenHash(token)}`);
}
