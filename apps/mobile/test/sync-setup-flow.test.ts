import { describe, expect, it, vi } from 'vitest';
import {
  NETWORK_FAILURE_MESSAGE,
  PRIVATE_BETA_MESSAGE,
  SUBSCRIPTION_ACTIVATION_HINT,
  SUBSCRIPTION_REQUIRED_MESSAGE,
} from '../src/lib/sync-errors.js';
import {
  DEFAULT_SYNC_SERVER_URL,
  runEnableSync,
  type EnableSyncPorts,
} from '../src/lib/sync-setup-flow.js';
import type { SyncEvent } from '../src/lib/sync-flow.js';

/**
 * Phase A enable-sync decision flow. Accounts are implicit (ADR 0009), so the
 * whole sequence is: save URL, first push, classify the outcome. The contract
 * under test: the URL is saved BEFORE the push and KEPT on every failure
 * (that persistence is what makes sync activate automatically later), and the
 * 402 outcome carries only the neutral activation copy.
 */

const URL = 'https://sync.example.test';

function makePorts(
  firstPush: () => Promise<SyncEvent>,
): { ports: EnableSyncPorts; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      saveServerUrl: vi.fn(async (url: string) => {
        calls.push(`save(${url})`);
      }),
      runFirstPush: vi.fn(async () => {
        calls.push('push');
        return firstPush();
      }),
    },
  };
}

describe('runEnableSync', () => {
  it('saves the URL before pushing and reports enabled on a clean first push', async () => {
    const { ports, calls } = makePorts(async () => ({ type: 'synced', version: 1 }));
    const outcome = await runEnableSync(ports, URL);
    expect(outcome).toEqual({ kind: 'enabled', version: 1, recoveredConflict: false });
    expect(calls).toEqual([`save(${URL})`, 'push']);
  });

  it('treats a conflict-recovered first push as enabled (re-enabling an account with a blob)', async () => {
    const { ports } = makePorts(async () => ({ type: 'conflict-recovered', version: 6 }));
    const outcome = await runEnableSync(ports, URL);
    expect(outcome).toEqual({ kind: 'enabled', version: 6, recoveredConflict: true });
  });

  it('maps a thrown 402 to the neutral subscription-required outcome, URL kept', async () => {
    const err = new Error(
      'This sync server requires a $10/month subscription. Run "northkeep sync subscribe".',
    );
    err.name = 'SubscriptionRequiredError';
    const { ports } = makePorts(async () => {
      throw err;
    });
    const outcome = await runEnableSync(ports, URL);
    expect(outcome).toEqual({
      kind: 'subscription-required',
      message: SUBSCRIPTION_REQUIRED_MESSAGE,
      hint: SUBSCRIPTION_ACTIVATION_HINT,
    });
    // The server's CLI copy never leaks into the outcome.
    expect(JSON.stringify(outcome)).not.toMatch(/\$10|northkeep sync subscribe/);
    // The URL stays saved: activation is automatic once the subscription is live.
    expect(ports.saveServerUrl).toHaveBeenCalledWith(URL);
  });

  it('maps a thrown HTTP 403 to the private-beta outcome', async () => {
    const { ports } = makePorts(async () => {
      throw new Error('Sync server returned HTTP 403 on push.');
    });
    const outcome = await runEnableSync(ports, URL);
    expect(outcome).toEqual({ kind: 'private-beta', message: PRIVATE_BETA_MESSAGE });
  });

  it('maps a network failure to a retryable failed outcome', async () => {
    const { ports } = makePorts(async () => {
      throw new TypeError('Network request failed');
    });
    const outcome = await runEnableSync(ports, URL);
    expect(outcome).toEqual({ kind: 'failed', message: NETWORK_FAILURE_MESSAGE, retryable: true });
  });

  it('maps an error EVENT from the push sequence (e.g. locked-vault conflict) to failed', async () => {
    const { ports } = makePorts(async () => ({
      type: 'error',
      message: 'Unlock the vault to resolve the sync conflict.',
    }));
    const outcome = await runEnableSync(ports, URL);
    expect(outcome).toEqual({
      kind: 'failed',
      message: 'Unlock the vault to resolve the sync conflict.',
      retryable: true,
    });
  });
});

describe('DEFAULT_SYNC_SERVER_URL', () => {
  it('is the https production server', () => {
    expect(DEFAULT_SYNC_SERVER_URL).toBe('https://northkeep-sync-server.vercel.app');
  });
});
