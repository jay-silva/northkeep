import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// This test file is an ES module; `require` isn't defined. Build one explicitly
// for the CJS-only `sodium-native` native addon.
const nodeRequire = createRequire(import.meta.url);

/**
 * M5b acceptance — Stripe billing gates hosted sync — driven through the real
 * CLI against the real sync + billing handlers, with a FAKE Stripe gateway
 * injected (no real Stripe keys, no network). Proves the plan's acceptance test:
 *  - a non-allowlisted account is refused with 402 until it subscribes;
 *  - a checkout.session.completed webhook enables sync;
 *  - a customer.subscription.deleted webhook blocks it again;
 *  - an allowlisted account syncs free throughout (never subscribes);
 *  - a forged webhook (bad signature) is rejected and grants nothing;
 *  - the stored subscription row holds NO email/card — only ids + status.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const serverLib = path.join(repoRoot, 'apps', 'sync-server', 'dist', 'lib.js');
const PASSPHRASE = 'm5b billing acceptance passphrase';

let homePay: string; // non-allowlisted → must subscribe
let homeFree: string; // allowlisted → free
let server: import('node:http').Server;
let storage: { getSubscription(h: string): Promise<Record<string, unknown> | null> };
let serverUrl: string;
const priorAllowlist = process.env.NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES;

function cli(home: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          NORTHKEEP_HOME: home,
          NORTHKEEP_PASSPHRASE: PASSPHRASE,
          NORTHKEEP_NO_KEYCHAIN: '1',
        },
        encoding: 'utf8',
      },
      (err, stdout, stderr) =>
        resolve({ stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
    );
  });
}

/** The account's bearer token, re-derived from its device.secret (mirrors the client). */
function tokenFor(home: string): string {
  const hex = fs.readFileSync(path.join(home, 'device.secret'), 'utf8').trim();
  const deviceSecret = Buffer.from(hex, 'hex');
  const sodium = nodeRequire('sodium-native');
  const out = Buffer.alloc(32);
  sodium.crypto_generichash(out, Buffer.from('nk-sync-token-v1', 'utf8'), deviceSecret);
  return out.toString('hex');
}

const hashOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** A fake Stripe: verifyWebhook accepts the body as the event iff signature==='good'. */
function fakeGateway() {
  return {
    async createCheckoutSession(a: { clientReferenceId: string }) {
      return { url: `https://checkout.stripe.test/session#${a.clientReferenceId}` };
    },
    async createPortalSession(a: { customerId: string }) {
      return { url: `https://billing.stripe.test/portal#${a.customerId}` };
    },
    async retrieveSubscription() {
      return { status: 'active', currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 };
    },
    verifyWebhook(rawBody: Buffer, signature: string) {
      if (signature !== 'good') throw new Error('bad signature');
      // Mirror the real gateway (createStripeGateway): Stripe events arrive as
      // { type, data: { object } } on the wire and are normalized to
      // { type, object } for the handler.
      const p = JSON.parse(rawBody.toString('utf8')) as { type: string; data: { object: Record<string, unknown> } };
      return { type: p.type, object: p.data.object };
    },
  };
}

/** Post a webhook using Stripe's real wire envelope: { type, data: { object } }. */
async function postWebhook(event: { type: string; object: Record<string, unknown> }, signature: string): Promise<number> {
  const res = await fetch(`${serverUrl}/api/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: JSON.stringify({ type: event.type, data: { object: event.object } }),
  });
  return res.status;
}

beforeAll(async () => {
  expect(fs.existsSync(cliPath), 'run pnpm build first').toBe(true);
  expect(fs.existsSync(serverLib), 'run pnpm build first').toBe(true);
  homePay = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-m5bPay-'));
  homeFree = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-m5bFree-'));

  // Init both accounts first so we can allowlist the free one before the server
  // reads the env at construction time.
  await cli(homePay, ['init']);
  await cli(homeFree, ['init']);
  process.env.NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES = hashOf(tokenFor(homeFree));

  const { createSyncServer, InMemoryStorage } = await import(serverLib);
  const store = new InMemoryStorage();
  storage = store;
  const billing = { gateway: fakeGateway(), config: { priceId: 'price_test', publicBaseUrl: 'https://nk.test' } };
  server = createSyncServer(store, billing);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  if (priorAllowlist === undefined) delete process.env.NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES;
  else process.env.NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES = priorAllowlist;
  fs.rmSync(homePay, { recursive: true, force: true });
  fs.rmSync(homeFree, { recursive: true, force: true });
});

describe('M5b acceptance — Stripe billing gates hosted sync', () => {
  it('a non-allowlisted account is refused (402) until it subscribes', async () => {
    await cli(homePay, ['remember', 'A secret about the paying user.', '--type', 'semantic']);
    await cli(homePay, ['sync', 'config', '--server', serverUrl]);
    const push = await cli(homePay, ['sync', 'push']);
    expect(push.code).not.toBe(0);
    expect(push.stderr + push.stdout).toMatch(/subscription/i);
  });

  it('subscribe prints a Stripe-hosted checkout URL (no card on us)', async () => {
    const sub = await cli(homePay, ['sync', 'subscribe']);
    expect(sub.stdout).toContain('https://checkout.stripe.test/');
    // The checkout is keyed by the account's token hash (not a secret).
    expect(sub.stdout).toContain(hashOf(tokenFor(homePay)));
  });

  it('a checkout.session.completed webhook enables sync', async () => {
    const status = await postWebhook(
      {
        type: 'checkout.session.completed',
        object: { client_reference_id: hashOf(tokenFor(homePay)), customer: 'cus_pay', subscription: 'sub_pay' },
      },
      'good',
    );
    expect(status).toBe(200);
    const push = await cli(homePay, ['sync', 'push']);
    expect(push.code).toBe(0);
    expect(push.stdout).toContain('version 1');
  });

  it('the stored subscription row holds NO email or card — only ids + status', async () => {
    const sub = await storage.getSubscription(hashOf(tokenFor(homePay)));
    expect(sub).not.toBeNull();
    const json = JSON.stringify(sub);
    expect(json).not.toMatch(/email|card|number|@/i);
    expect(sub).toMatchObject({ stripeCustomerId: 'cus_pay', stripeSubscriptionId: 'sub_pay', status: 'active' });
  });

  it('a customer.subscription.deleted webhook blocks sync again', async () => {
    const status = await postWebhook(
      {
        type: 'customer.subscription.deleted',
        object: { id: 'sub_pay', status: 'canceled', current_period_end: Math.floor(Date.now() / 1000) + 3600 },
      },
      'good',
    );
    expect(status).toBe(200);
    await cli(homePay, ['remember', 'Another note after cancelling.', '--type', 'semantic']);
    const push = await cli(homePay, ['sync', 'push']);
    expect(push.code).not.toBe(0);
    expect(push.stderr + push.stdout).toMatch(/subscription/i);
  });

  it('a forged webhook (bad signature) is rejected and grants nothing', async () => {
    const status = await postWebhook(
      {
        type: 'checkout.session.completed',
        object: { client_reference_id: hashOf(tokenFor(homePay)), customer: 'cus_x', subscription: 'sub_x' },
      },
      'FORGED',
    );
    expect(status).toBe(400);
    const push = await cli(homePay, ['sync', 'push']);
    expect(push.code).not.toBe(0);
  });

  it('an allowlisted account syncs free throughout — never subscribes', async () => {
    await cli(homeFree, ['remember', 'The free (allowlisted) user note.', '--type', 'semantic']);
    await cli(homeFree, ['sync', 'config', '--server', serverUrl]);
    const push = await cli(homeFree, ['sync', 'push']);
    expect(push.code).toBe(0);
    expect(push.stdout).toContain('version 1');
    // And it was never charged: no subscription row exists for it.
    expect(await storage.getSubscription(hashOf(tokenFor(homeFree)))).toBeNull();
  });
});
