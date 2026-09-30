import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConnectorStalePushError,
  holdMessage,
  LAPSED_UNSHARE_HINT,
  UNSHARE_FAILED_MESSAGE,
  UNSHARE_LOCAL_SAVE_FAILED_MESSAGE,
  vaultServerHash,
} from '@northkeep/sync';
import {
  CONNECTOR_NETWORK_MESSAGE,
  CONNECTOR_PRIVATE_BETA_MESSAGE,
  CONNECTOR_SUBSCRIPTION_HINT,
  CONNECTOR_SUBSCRIPTION_MESSAGE,
  DEFAULT_CONNECTOR_SERVER_URL,
  NOTHING_SHARED_MESSAGE,
  PAIRING_CODE_TTL_SECONDS,
  PHONE_NOT_IN_SYNC_MESSAGE,
  PHONE_STALE_PUSH_MESSAGE,
  PhoneNotInSyncError,
  canSyncNow,
  classifyConnectorError,
  connectorSyncSummary,
  formatPairingCountdown,
  mcpUrlFor,
  newlySharedMessage,
  phoneVaultStamp,
  runConnectorSyncNow,
  runShareScope,
  runUnshareScope,
  scopeRows,
  shareIdFromConnectorToken,
  vaultServerHashForPhone,
  type ShareScopePorts,
  type SharedScopeStore,
  unshareFailureText,
} from '../src/lib/connect-flow.js';
import {
  CONVERSATIONS_SCOPE,
  JOURNAL_HONESTY_NOTE,
  JOURNAL_PATTERN_SCHEDULED_TASK,
  JOURNAL_PATTERN_STANDING_INSTRUCTION,
  JOURNAL_SEED_MEMORY,
  hasConversationsScope,
} from '../src/lib/journal-recipe.js';

/**
 * Phase B Cloud Connect orchestration. The load-bearing assertions:
 *  - the share id equals node:crypto's sha256 hex (the server-side tokenHash),
 *    since mobile computes it with @noble/hashes instead of node:crypto;
 *  - share ROLLS BACK the local mark when the push fails (no phantom Shared
 *    badge), and unshare KEEPS the mark when the server delete fails (the
 *    server really still holds the copies);
 *  - sync-now never pushes to Cloud Connect (ADR 0063 D1), and a share
 *    push is stamped with the sync-server copy the phone holds, or refused;
 *  - every user-facing string is steering-clean and em-dash-free.
 */

/** In-memory SharedScopeStore fake that records every save for rollback assertions. */
function memStore(initial: string[] = []) {
  let scopes = [...initial];
  const saves: string[][] = [];
  const store: SharedScopeStore = {
    load: async () => [...scopes],
    save: async (next: string[]) => {
      scopes = [...next];
      saves.push([...next]);
    },
  };
  return { store, saves, get: () => [...scopes] };
}

/** runShareScope's ports over a memStore: in sync with no stamp, the mark saved locally, each step logged in order. */
function sharePorts(
  store: SharedScopeStore,
  over: Partial<ShareScopePorts> = {},
): { ports: ShareScopePorts; steps: string[] } {
  const steps: string[] = [];
  const ports: ShareScopePorts = {
    store,
    stamp: async () => {
      steps.push('stamp');
      return undefined;
    },
    markLocal: async (scopes) => {
      steps.push('mark');
      await store.save(scopes);
    },
    pushScopes: async () => ({ pushed: 0 }),
    syncVault: async () => {
      steps.push('vault push');
    },
    ...over,
  };
  return { ports, steps };
}

/** Things that must never reach a mobile user (App Store steering + the em-dash rule). */
function expectSteeringClean(text: string) {
  expect(text).not.toMatch(/\$\s*\d/); // no price
  expect(text).not.toMatch(/https?:|www\./i); // no link or website
  expect(text).not.toMatch(/subscribe\b/i); // no purchase verb ("subscribed" is fine)
  expect(text).not.toMatch(/[—–]/); // no em or en dashes anywhere in user copy
}

describe('shareIdFromConnectorToken', () => {
  it('matches node:crypto sha256 hex (the value tokenHash() gives the allowlist)', () => {
    for (const token of ['abc123', 'f'.repeat(64), 'nk-connector-token-example']) {
      const expected = createHash('sha256').update(token, 'utf8').digest('hex');
      expect(shareIdFromConnectorToken(token)).toBe(expected);
    }
  });
});

describe('mcpUrlFor / defaults', () => {
  it('appends /mcp, stripping one trailing slash (desktop mcpUrl behavior)', () => {
    expect(mcpUrlFor('https://x.example')).toBe('https://x.example/mcp');
    expect(mcpUrlFor('https://x.example/')).toBe('https://x.example/mcp');
  });

  it('production default is https and the pairing TTL matches the server', () => {
    expect(DEFAULT_CONNECTOR_SERVER_URL).toBe('https://northkeep-connector-server.vercel.app');
    expect(PAIRING_CODE_TTL_SECONDS).toBe(600);
  });
});

describe('formatPairingCountdown', () => {
  it('renders m:ss and clamps at 0:00', () => {
    expect(formatPairingCountdown(600)).toBe('10:00');
    expect(formatPairingCountdown(61)).toBe('1:01');
    expect(formatPairingCountdown(9)).toBe('0:09');
    expect(formatPairingCountdown(0)).toBe('0:00');
    expect(formatPairingCountdown(-5)).toBe('0:00');
  });
});

describe('scopeRows', () => {
  it('unions vault scopes with the shared list, counts live entries, and sorts', () => {
    const entries = [
      { scope: 'work' },
      { scope: 'work' },
      { scope: 'personal' },
    ];
    // 'conversations' is shared but currently empty: it still needs a row so
    // the user can turn it off.
    expect(scopeRows(entries, ['conversations', 'work'])).toEqual([
      { scope: 'conversations', count: 0, shared: true },
      { scope: 'personal', count: 1, shared: false },
      { scope: 'work', count: 2, shared: true },
    ]);
  });

  it('is empty for an empty vault with nothing shared', () => {
    expect(scopeRows([], [])).toEqual([]);
  });
});

describe('runShareScope', () => {
  it('persists the mark (deduped, sorted) and pushes ALL shared scopes', async () => {
    const { store, get } = memStore(['work']);
    const pushedWith: string[][] = [];
    const outcome = await runShareScope(
      sharePorts(store, {
          pushScopes: async (scopes) => {
            pushedWith.push(scopes);
            return { pushed: 7 };
          },
      }).ports,
      'conversations',
    );
    expect(outcome).toEqual({ kind: 'shared', scope: 'conversations', pushed: 7 });
    // The push must carry the FULL shared list, not just the new scope.
    expect(pushedWith).toEqual([[ 'conversations', 'work' ]]);
    expect(get()).toEqual(['conversations', 'work']);
  });

  it('rolls the mark back when the push fails, and classifies the 402 neutrally', async () => {
    const { store, saves, get } = memStore(['work']);
    const outcome = await runShareScope(
      sharePorts(store, {
          pushScopes: async () => {
            throw new Error('Connector server returned HTTP 402 on push.');
          },
      }).ports,
      'conversations',
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.errorKind).toBe('subscription-required');
      expect(outcome.message).toContain(CONNECTOR_SUBSCRIPTION_MESSAGE);
      expect(outcome.message).toContain(CONNECTOR_SUBSCRIPTION_HINT);
      expectSteeringClean(outcome.message);
    }
    // Mark then rollback: the store ends exactly where it started.
    expect(saves).toEqual([['conversations', 'work'], ['work']]);
    expect(get()).toEqual(['work']);
  });

  /**
   * REGRESSION (ADR 0038 review F1): the scope was ALREADY shared — e.g. marked
   * on the Mac and synced into the vault while this screen's state was stale —
   * and the user taps Share again, and the push fails. Rolling back would
   * unmark a legitimately shared scope with NO server delete: every device
   * would then claim Private while the connector still holds the rows.
   */
  it('never rolls back a scope that was already shared before the call', async () => {
    const { store, get } = memStore(['conversations', 'work']);
    const outcome = await runShareScope(
      sharePorts(store, {
          pushScopes: async () => {
            throw new Error('Connector server returned HTTP 500 on push.');
          },
      }).ports,
      'work', // already in the store
    );
    expect(outcome.kind).toBe('failed');
    expect(get()).toEqual(['conversations', 'work']); // mark untouched
  });

  it('rollback removes only its OWN scope, keeping a concurrent writer\'s mark', async () => {
    const { store, get } = memStore(['work']);
    const outcome = await runShareScope(
      sharePorts(store, {
          pushScopes: async () => {
            // While the push is in flight, a concurrent writer marks another
            // scope. The rollback must not blind-overwrite with the stale
            // pre-push snapshot and erase it.
            await store.save(['concurrent', 'conversations', 'work']);
            throw new Error('Connector server returned HTTP 500 on push.');
          },
      }).ports,
      'conversations',
    );
    expect(outcome.kind).toBe('failed');
    // Only 'conversations' (this call's own mark) is removed; the concurrent
    // writer's 'concurrent' mark and the pre-existing 'work' both survive.
    expect(get()).toEqual(['concurrent', 'work']);
  });

  it('maps a transport failure to the connector-flavored network copy', async () => {
    const { store, get } = memStore([]);
    const outcome = await runShareScope(
      sharePorts(store, {
          pushScopes: async () => {
            throw new TypeError('Network request failed');
          },
      }).ports,
      'work',
    );
    expect(outcome).toEqual({ kind: 'failed', errorKind: 'network', message: CONNECTOR_NETWORK_MESSAGE });
    expect(get()).toEqual([]);
  });
});

describe('runUnshareScope', () => {
  it('deletes server-side first, then drops the local mark', async () => {
    const { store, get } = memStore(['conversations', 'work']);
    const outcome = await runUnshareScope(
      { store, unshare: async () => ({ deleted: 4 }) },
      'conversations',
    );
    expect(outcome).toEqual({ kind: 'unshared', scope: 'conversations', deleted: 4 });
    expect(get()).toEqual(['work']);
  });

  it('ADR 0061: a failed unshare says it is still Shared, never subscription copy, even on a 402', async () => {
    const { store, get } = memStore(['conversations']);
    const outcome = await runUnshareScope(
      {
        store,
        unshare: async () => {
          throw new Error('Connector server returned HTTP 402 on unshare.');
        },
      },
      'conversations',
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.message).toBe(UNSHARE_FAILED_MESSAGE);
      expect(outcome.message).not.toContain(CONNECTOR_SUBSCRIPTION_MESSAGE);
    }
    expect(get()).toEqual(['conversations']);
  });

  it('ADR 0061: server delete succeeded but the local save failed: says so', async () => {
    const outcome = await runUnshareScope(
      {
        store: {
          load: async () => ['conversations'],
          save: async () => {
            throw new Error('disk full');
          },
        },
        unshare: async () => ({ deleted: 2 }),
      },
      'conversations',
    );
    expect(outcome).toEqual({ kind: 'failed', errorKind: 'other', message: UNSHARE_LOCAL_SAVE_FAILED_MESSAGE });
  });

  it('ADR 0061: the Sharing screen shows each unshare failure message verbatim, with nothing appended', async () => {
    const local = await runUnshareScope(
      {
        store: { load: async () => ['c'], save: async () => { throw new Error('disk full'); } },
        unshare: async () => ({ deleted: 1 }),
      },
      'c',
    );
    const server = await runUnshareScope(
      { store: memStore(['c']).store, unshare: async () => { throw new Error('Connector server returned HTTP 500 on unshare.'); } },
      'c',
    );
    if (local.kind !== 'failed' || server.kind !== 'failed') throw new Error('expected failures');
    expect(unshareFailureText(local)).toBe(UNSHARE_LOCAL_SAVE_FAILED_MESSAGE);
    expect(unshareFailureText(server)).toBe(UNSHARE_FAILED_MESSAGE);
    const screen = readFileSync(fileURLToPath(new URL('../app/sharing/scopes.tsx', import.meta.url).href), 'utf8');
    expect(screen).toContain('unshareFailureText(outcome)');
    expect(screen).not.toContain('were not removed');
  });

  it('ADR 0061: a connector 402 adds the unshare sentence', () => {
    const r = classifyConnectorError(new Error('Connector server returned HTTP 402 on push.'));
    expect(r.message).toContain(LAPSED_UNSHARE_HINT);
    expect(r.message).not.toMatch(/\u2014/);
  });

  it('keeps the mark when the server delete fails (the server still holds copies)', async () => {
    const { store, saves, get } = memStore(['conversations']);
    const outcome = await runUnshareScope(
      {
        store,
        unshare: async () => {
          throw new Error('Connector server returned HTTP 500 on unshare.');
        },
      },
      'conversations',
    );
    expect(outcome.kind).toBe('failed');
    expect(saves).toEqual([]); // never touched
    expect(get()).toEqual(['conversations']);
  });
});

describe('runConnectorSyncNow', () => {
  it('refuses when nothing is shared', async () => {
    const { store } = memStore([]);
    const outcome = await runConnectorSyncNow({
      store,
      paired: async () => false,
      downSync: async () => {
        throw new Error('must not be called');
      },
    });
    expect(outcome).toEqual({ kind: 'nothing-shared', message: NOTHING_SHARED_MESSAGE });
  });

  it('down-syncs and reports the counts, with no port left that could push (ADR 0063 D1)', async () => {
    const { store } = memStore(['conversations']);
    const ports = {
      store,
      paired: async () => false,
      downSync: async () => ({ added: 3, forgotten: 0, deduped: 2, held: 0, held_scopes: [] }),
    };
    const outcome = await runConnectorSyncNow(ports);
    expect(Object.keys(ports).sort()).toEqual(['downSync', 'paired', 'store']);
    expect(outcome).toEqual({
      kind: 'synced',
      added: 3,
      forgotten: 0,
      deduped: 2,
      held: 0,
      held_scopes: [],
      newlyShared: [],
    });
  });

  // --- ADR 0050 Decision 5: a paired phone folds from an empty shared list ---

  it('reports the scope the fold marked Shared when paired with nothing shared', async () => {
    const { store } = memStore([]);
    const outcome = await runConnectorSyncNow({
      store,
      paired: async () => true,
      downSync: async () => {
        await store.save(['project:hosted-thing']); // the fold marked it
        return { added: 1, forgotten: 0, deduped: 0, held: 0, held_scopes: [] };
      },
    });
    expect(outcome).toMatchObject({ kind: 'synced', added: 1, newlyShared: ['project:hosted-thing'] });
    expect(connectorSyncSummary(outcome as never)).toContain(newlySharedMessage('project:hosted-thing'));
    expect(newlySharedMessage('project:hosted-thing')).toMatch(/now marked Shared\. Later edits to it are pushed/);
  });

  it('still refuses without a pairing, and never calls the connector', async () => {
    const { store } = memStore([]);
    const outcome = await runConnectorSyncNow({
      store,
      paired: async () => false,
      downSync: async () => {
        throw new Error('must not be called');
      },
    });
    expect(outcome).toEqual({ kind: 'nothing-shared', message: NOTHING_SHARED_MESSAGE });
  });

  it('reports a held project by its slug', async () => {
    const { store } = memStore([]);
    const outcome = await runConnectorSyncNow({
      store,
      paired: async () => true,
      downSync: async () => ({ added: 0, forgotten: 0, deduped: 0, held: 1, held_scopes: ['project:held-one'] }),
    });
    expect(outcome).toEqual({
      kind: 'synced',
      added: 0,
      forgotten: 0,
      deduped: 0,
      held: 1,
      held_scopes: ['project:held-one'],
      newlyShared: [],
    });
    const summary = connectorSyncSummary(outcome as never);
    expect(summary).toContain(holdMessage('held-one'));
    // The slug, not the scope: "project project:held-one" would be the bug.
    expect(summary).not.toContain('project:project:');
    expectSteeringClean(summary);
  });

  it('classifies the down-sync 402 (which has no "HTTP 402" token) neutrally', async () => {
    const { store } = memStore(['conversations']);
    const outcome = await runConnectorSyncNow({
      store,
      paired: async () => false,
      downSync: async () => {
        throw new Error('The connector server requires an active subscription (402) to down-sync.');
      },
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.errorKind).toBe('subscription-required');
      expectSteeringClean(outcome.message);
    }
  });
});

describe('phoneVaultStamp (ADR 0063 D5 on the phone)', () => {
  const SERVER = 'https://sync.example.test';
  const status = { version: 7, sha256: 'a'.repeat(64) };

  it('hashes the sync server URL exactly as the desktop does, for the stored and the unnormalized form', () => {
    // The desktop hashes sync.json's URL, which setSyncServer stores as URL.toString() without the trailing slash.
    expect(vaultServerHashForPhone('https://sync.example.test')).toBe(vaultServerHash('https://sync.example.test'));
    expect(vaultServerHashForPhone('https://sync.example.test/')).toBe(vaultServerHash('https://sync.example.test'));
    expect(vaultServerHashForPhone('HTTPS://Sync.Example.Test')).toBe(vaultServerHash('https://sync.example.test'));
    expect(vaultServerHashForPhone('http://127.0.0.1:4321')).toBe(vaultServerHash('http://127.0.0.1:4321'));
    expect(vaultServerHashForPhone(SERVER)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stamps the server version when the phone holds exactly the server bytes', () => {
    expect(phoneVaultStamp({ syncServerUrl: SERVER, status, localSha: status.sha256 })).toEqual({
      server: vaultServerHash(SERVER),
      version: 7,
    });
  });

  it('sends no stamp with no sync server, like a desktop with no vault sync', () => {
    expect(phoneVaultStamp({ syncServerUrl: null, status: null, localSha: null })).toBeUndefined();
  });

  it('refuses when the phone holds other bytes, or the server has no vault yet', () => {
    for (const input of [
      { syncServerUrl: SERVER, status, localSha: 'b'.repeat(64) },
      { syncServerUrl: SERVER, status: null, localSha: 'b'.repeat(64) },
      { syncServerUrl: SERVER, status, localSha: null },
    ]) {
      expect(() => phoneVaultStamp(input)).toThrow(PhoneNotInSyncError);
    }
  });

  it('a phone that is not in sync refuses before writing anything: no mark, no Cloud Connect push, no vault push', async () => {
    const { store, saves } = memStore(['work']);
    let pushes = 0;
    const { ports, steps } = sharePorts(store, {
      stamp: async () => phoneVaultStamp({ syncServerUrl: SERVER, status, localSha: 'b'.repeat(64) }),
      pushScopes: async () => {
        pushes += 1;
        return { pushed: 1 };
      },
    });
    const outcome = await runShareScope(ports, 'conversations');
    expect(outcome).toEqual({ kind: 'failed', errorKind: 'other', message: PHONE_NOT_IN_SYNC_MESSAGE });
    expect(PHONE_NOT_IN_SYNC_MESSAGE).toBe(
      'This phone is not in sync with your other devices yet, so nothing was shared. Let sync finish, then share again.',
    );
    expect(saves).toEqual([]);
    expect(pushes).toBe(0);
    expect(steps).toEqual([]);
  });

  it('in sync: stamps before the mark, pushes with that stamp, and pushes the vault only after Cloud Connect accepted', async () => {
    const { store } = memStore([]);
    const stamped = phoneVaultStamp({ syncServerUrl: SERVER, status, localSha: status.sha256 });
    let sent: unknown = null;
    const { ports, steps } = sharePorts(store, {
      stamp: async () => {
        steps.push('stamp');
        return stamped;
      },
      pushScopes: async (_scopes, stamp) => {
        steps.push('cloud push');
        sent = stamp;
        return { pushed: 2 };
      },
    });
    expect(await runShareScope(ports, 'work')).toEqual({ kind: 'shared', scope: 'work', pushed: 2 });
    expect(steps).toEqual(['stamp', 'mark', 'cloud push', 'vault push']);
    expect(sent).toEqual({ server: vaultServerHashForPhone(SERVER), version: status.version });
  });

  it('a vault push that fails after Cloud Connect accepted keeps the share and its mark', async () => {
    const { store, get } = memStore([]);
    const { ports } = sharePorts(store, {
      pushScopes: async () => ({ pushed: 3 }),
      syncVault: async () => {
        throw new Error('No device secret on this phone yet.');
      },
    });
    expect(await runShareScope(ports, 'work')).toEqual({ kind: 'shared', scope: 'work', pushed: 3 });
    expect(get()).toEqual(['work']);
  });

  it('a refused share rolls its mark back and says why on the phone', async () => {
    const { store, get } = memStore([]);
    const outcome = await runShareScope(
      sharePorts(store, {
          pushScopes: async () => {
            throw new PhoneNotInSyncError();
          },
      }).ports,
      'work',
    );
    expect(outcome).toEqual({ kind: 'failed', errorKind: 'other', message: PHONE_NOT_IN_SYNC_MESSAGE });
    expect(get()).toEqual([]);
  });

  it('a 428 says what the phone can do, never the Mac command', () => {
    expect(classifyConnectorError(new ConnectorStalePushError(9))).toEqual({
      kind: 'failed',
      errorKind: 'other',
      message: PHONE_STALE_PUSH_MESSAGE,
    });
    expect(PHONE_STALE_PUSH_MESSAGE).not.toContain('northkeep');
  });
});

describe('canSyncNow (the Sync button gate, ADR 0050)', () => {
  it('is off on a phone that never paired and shares nothing', () => {
    expect(canSyncNow({ sharedCount: 0, paired: false })).toBe(false);
  });
  it('is on for a paired phone with nothing shared, so a hosted project can arrive', () => {
    expect(canSyncNow({ sharedCount: 0, paired: true })).toBe(true);
  });
  it('is on whenever a scope is shared', () => {
    expect(canSyncNow({ sharedCount: 2, paired: false })).toBe(true);
    expect(canSyncNow({ sharedCount: 1, paired: true })).toBe(true);
  });
  it('agrees with runConnectorSyncNow: a paired phone with nothing shared reaches the server', async () => {
    let downSynced = 0;
    const outcome = await runConnectorSyncNow({
      store: { load: async () => [], save: async () => undefined } as unknown as SharedScopeStore,
      downSync: async () => {
        downSynced += 1;
        return { added: 0, forgotten: 0, deduped: 0, held: 0, held_scopes: [], skipped: 0 } as never;
      },
      paired: async () => true,
    });
    expect(downSynced).toBe(1);
    expect(outcome.kind).toBe('synced');
  });
});

describe('classifyConnectorError', () => {
  it('handles every 402 shape the connector client actually throws', () => {
    for (const msg of [
      'Connector server returned HTTP 402 on push.',
      'Connector server returned HTTP 402 on pairing.',
      'Connector server returned HTTP 402 on unshare.',
      'The connector server requires an active subscription (402) to down-sync.',
    ]) {
      const result = classifyConnectorError(new Error(msg));
      expect(result.errorKind).toBe('subscription-required');
      expectSteeringClean(result.message);
    }
  });

  it('gives the connector 403 its own private-beta copy (right noun, no "sync server")', () => {
    const result = classifyConnectorError(new Error('Connector server returned HTTP 403 on push.'));
    expect(result).toEqual({
      kind: 'failed',
      errorKind: 'not-enabled',
      message: CONNECTOR_PRIVATE_BETA_MESSAGE,
    });
    expect(result.message).not.toContain('sync server');
    expect(result.message).toContain('connector server');
    expectSteeringClean(result.message);
  });

  it('surfaces a 412 tombstone as other, never as a 409 re-push', () => {
    const msg =
      'This scope was unshared. Re-share it deliberately if you want it back. Conflicting scopes: work.';
    const result = classifyConnectorError(Object.assign(new Error(msg), { name: 'ConnectorTombstoneError' }));
    expect(result).toEqual({ kind: 'failed', errorKind: 'other', message: msg });
    expect(result.message).not.toMatch(/409|re-encrypt|Re-push your shared scopes/i);
    expect(result.message).not.toContain('\u2014');
  });

  it('passes the connector cap message (413) through unchanged', () => {
    const msg =
      'The connector server rejected the push: over the sharing caps (too many shared memories, or a memory is too large).';
    expect(classifyConnectorError(new Error(msg))).toEqual({
      kind: 'failed',
      errorKind: 'other',
      message: msg,
    });
  });
});

describe('connectorSyncSummary', () => {
  it('says what waits for the Mac (ADR 0063: the phone applies additions only)', () => {
    expect(connectorSyncSummary({ added: 0, forgotten: 0, deduped: 0, deferred: 1, conflicts: [] })).toBe(
      'No new memories from your AI apps. 1 change from your AI apps would replace or remove something here. Review on your Mac.',
    );
    expect(connectorSyncSummary({ added: 0, forgotten: 0, deduped: 0, deferred: 1, conflicts: [{}] })).toContain('2 changes from your AI apps');
    expect(connectorSyncSummary({ added: 1, forgotten: 0, deduped: 0, deferred: 0, conflicts: [] })).not.toContain('Review on your Mac');
  });

  it('names skipped rows so a dropped memory is never silent', () => {
    expect(connectorSyncSummary({ added: 0, forgotten: 0, deduped: 0, skipped: 1 })).toContain(
      '1 memory was skipped: its type is not one NorthKeep stores.',
    );
    expect(connectorSyncSummary({ added: 0, forgotten: 0, deduped: 0, skipped: 2 })).toContain('2 memories were skipped');
    expect(connectorSyncSummary({ added: 0, forgotten: 0, deduped: 0, skipped: 0 })).not.toContain('skipped');
  });

  it('reads naturally for the common cases', () => {
    expect(connectorSyncSummary({ added: 0, forgotten: 0, deduped: 0 })).toBe('No new memories from your AI apps.');
    expect(connectorSyncSummary({ added: 1, forgotten: 0, deduped: 0 })).toContain(
      '1 new memory from your AI apps came into your vault.',
    );
    const full = connectorSyncSummary({ added: 2, forgotten: 1, deduped: 3 });
    expect(full).toContain('2 new memories from your AI apps came into your vault.');
    expect(full).toContain('1 forget was applied.');
    expect(full).toContain('3 were already in your vault.');
  });

  it('never claims the phone pushed anything back (ADR 0063 D1)', () => {
    expect(connectorSyncSummary({ added: 2, forgotten: 0, deduped: 0 })).toBe('2 new memories from your AI apps came into your vault.');
  });
});

describe('journal recipe (WS3) exact strings', () => {
  it('seeds the conversations scope BEFORE sharing (fail-closed order)', () => {
    expect(JOURNAL_SEED_MEMORY.scope).toBe(CONVERSATIONS_SCOPE);
    expect(CONVERSATIONS_SCOPE).toBe('conversations');
    expect(JOURNAL_SEED_MEMORY.type).toBe('semantic');
    expect(JOURNAL_SEED_MEMORY.content).toBe(
      'This scope holds automatic chat summaries from my AI apps.',
    );
  });

  it('carries the published patterns verbatim', () => {
    expect(JOURNAL_PATTERN_SCHEDULED_TASK).toBe(
      'Review my conversations from today. For each substantive one, write a two or three sentence summary. Store each summary in NorthKeep using memory_remember with type "episodic" and scope "conversations". Skip small talk and anything already stored.',
    );
    expect(JOURNAL_PATTERN_STANDING_INSTRUCTION).toBe(
      'Store this in NorthKeep as a procedural memory in scope "conversations": At the end of each substantive conversation, write a concise summary of it to NorthKeep as one episodic memory in scope "conversations". Do this when the conversation is winding down, or whenever I say "log this".',
    );
    expect(JOURNAL_HONESTY_NOTE).toBe(
      'these summaries live in a shared scope, so they sit on the connector encrypted at rest until they sync into your vault. After a Sync you can unshare the scope any time; the server copies delete and your vault keeps everything.',
    );
  });

  it('hasConversationsScope detects the scope', () => {
    expect(hasConversationsScope([{ scope: 'work' }])).toBe(false);
    expect(hasConversationsScope([{ scope: 'work' }, { scope: 'conversations' }])).toBe(true);
  });
});

describe('the user-facing copy stays steering-clean and em-dash-free', () => {
  it('audits every exported string', () => {
    for (const s of [
      CONNECTOR_SUBSCRIPTION_MESSAGE,
      CONNECTOR_SUBSCRIPTION_HINT,
      CONNECTOR_NETWORK_MESSAGE,
      CONNECTOR_PRIVATE_BETA_MESSAGE,
      NOTHING_SHARED_MESSAGE,
      PHONE_NOT_IN_SYNC_MESSAGE,
      PHONE_STALE_PUSH_MESSAGE,
      JOURNAL_SEED_MEMORY.content,
      JOURNAL_PATTERN_SCHEDULED_TASK,
      JOURNAL_PATTERN_STANDING_INSTRUCTION,
      JOURNAL_HONESTY_NOTE,
      connectorSyncSummary({ added: 2, forgotten: 1, deduped: 1 }),
    ]) {
      expectSteeringClean(s);
    }
  });
});
