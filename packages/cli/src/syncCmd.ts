import fs from 'node:fs';
import { Vault, deriveMasterKey, loadDeviceSecret, memzero } from '@northkeep/core';
import { resolveMasterKey } from '@northkeep/mcp-server';
import {
  checkoutUrl,
  deriveSyncCreds,
  loadSyncConfig,
  portalUrl,
  pullVault,
  pushVault,
  setSyncServer,
  subscriptionStatus,
  SubscriptionRequiredError,
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
  let result: Awaited<ReturnType<typeof pushVault>>;
  try {
    result = await pushVault({ vaultPath, deviceSecret });
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) fail(SUBSCRIBE_HINT);
    throw err;
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

export async function syncPull(vaultPath: string, fail: (m: string) => never): Promise<void> {
  const deviceSecret = deviceSecretOrFail(fail);
  if (!loadSyncConfig()) fail('Sync is not configured. Run: northkeep sync config --server <url>');
  const localExists = fs.existsSync(vaultPath);

  // Protect an existing local vault: prove the pulled blob opens with our key
  // BEFORE it replaces the local file. A fresh machine has nothing to protect.
  let masterKey: Buffer | undefined;
  if (localExists) {
    const resolved = resolveMasterKey(vaultPath);
    if (resolved) {
      masterKey = resolved.key;
    } else {
      const passphrase = await getPassphrase('Passphrase (to verify the pulled vault): ');
      const header = Vault.readHeader(vaultPath);
      masterKey = deriveMasterKey(passphrase, deviceSecret, header.salt, header.kdf);
    }
  }
  try {
    const result = await pullVault({ vaultPath, deviceSecret, masterKey });
    if (!result.ok) {
      fail('Nothing to pull — no vault has been pushed to this sync server yet.');
    }
    console.log(`✓ Pulled version ${result.version}. Your vault is up to date.`);
    if (!localExists) {
      console.log('  Open it with your passphrase: northkeep list');
    }
  } catch (err) {
    if (err instanceof SubscriptionRequiredError) fail(SUBSCRIBE_HINT);
    throw err;
  } finally {
    if (masterKey) memzero(masterKey);
  }
}

export async function syncStatusCmd(vaultPath: string, fail: (m: string) => never): Promise<void> {
  const deviceSecret = deviceSecretOrFail(fail);
  const config = loadSyncConfig();
  if (!config) {
    console.log('Sync is not configured. Run: northkeep sync config --server <url>');
    return;
  }
  const { state, localVersion, remoteVersion } = await syncState({ vaultPath, deviceSecret });
  console.log(`Server: ${config.serverUrl}`);

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
      console.log('Subscription: none. This server bills $10/month — run: northkeep sync subscribe');
    }
  } catch {
    // Older servers (pre-billing) may not expose /api/subscription; stay quiet.
  }

  const message =
    state === 'in-sync'
      ? '✓ In sync.'
      : state === 'behind'
        ? `↓ Behind — the server has newer changes (local v${localVersion}, server v${remoteVersion}). Run: northkeep sync pull`
        : state === 'ahead'
          ? `↑ Ahead — you have local changes not pushed (local v${localVersion}, server v${remoteVersion}). Run: northkeep sync push`
          : state === 'no-remote'
            ? 'No vault has been pushed to the server yet. Run: northkeep sync push'
            : state === 'no-local'
              ? `No local vault; the server has version ${remoteVersion}. Run: northkeep sync pull`
              : 'Sync is not configured.';
  console.log(message);
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
  console.log('Your card is entered on Stripe — it never touches Northkeep. After you subscribe,');
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
