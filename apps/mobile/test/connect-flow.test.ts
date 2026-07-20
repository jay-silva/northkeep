import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_NETWORK_MESSAGE,
  CONNECTOR_SUBSCRIPTION_HINT,
  CONNECTOR_SUBSCRIPTION_MESSAGE,
  DEFAULT_CONNECTOR_SERVER_URL,
  NOTHING_SHARED_MESSAGE,
  PAIRING_CODE_TTL_SECONDS,
  classifyConnectorError,
  connectorSyncSummary,
  formatPairingCountdown,
  mcpUrlFor,
  runConnectorSyncNow,
  runShareScope,
  runUnshareScope,
  scopeRows,
  shareIdFromConnectorToken,
  type SharedScopeStore,
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
 *  - sync-now runs down-sync BEFORE the write-back push (desktop order);
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
      {
        store,
        pushScopes: async (scopes) => {
          pushedWith.push(scopes);
          return { pushed: 7 };
        },
      },
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
      {
        store,
        pushScopes: async () => {
          throw new Error('Connector server returned HTTP 402 on push.');
        },
      },
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

  it('maps a transport failure to the connector-flavored network copy', async () => {
    const { store, get } = memStore([]);
    const outcome = await runShareScope(
      {
        store,
        pushScopes: async () => {
          throw new TypeError('Network request failed');
        },
      },
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
      downSync: async () => {
        throw new Error('must not be called');
      },
      pushScopes: async () => {
        throw new Error('must not be called');
      },
    });
    expect(outcome).toEqual({ kind: 'nothing-shared', message: NOTHING_SHARED_MESSAGE });
  });

  it('down-syncs BEFORE the write-back push, and reports the counts', async () => {
    const { store } = memStore(['conversations']);
    const calls: string[] = [];
    const outcome = await runConnectorSyncNow({
      store,
      downSync: async () => {
        calls.push('down');
        return { added: 3, forgotten: 1, deduped: 2 };
      },
      pushScopes: async (scopes) => {
        calls.push(`push:${scopes.join(',')}`);
        return { pushed: 9 };
      },
    });
    expect(calls).toEqual(['down', 'push:conversations']);
    expect(outcome).toEqual({ kind: 'synced', added: 3, forgotten: 1, deduped: 2, pushed: 9 });
  });

  it('classifies the down-sync 402 (which has no "HTTP 402" token) neutrally', async () => {
    const { store } = memStore(['conversations']);
    const outcome = await runConnectorSyncNow({
      store,
      downSync: async () => {
        throw new Error('The connector server requires an active subscription (402) to down-sync.');
      },
      pushScopes: async () => ({ pushed: 0 }),
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.errorKind).toBe('subscription-required');
      expectSteeringClean(outcome.message);
    }
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
  it('reads naturally for the common cases', () => {
    expect(connectorSyncSummary({ added: 0, forgotten: 0, deduped: 0 })).toBe(
      'No new memories from your AI apps. Your shared scopes were pushed back so the server matches your vault.',
    );
    expect(connectorSyncSummary({ added: 1, forgotten: 0, deduped: 0 })).toContain(
      '1 new memory from your AI apps came into your vault.',
    );
    const full = connectorSyncSummary({ added: 2, forgotten: 1, deduped: 3 });
    expect(full).toContain('2 new memories from your AI apps came into your vault.');
    expect(full).toContain('1 forget was applied.');
    expect(full).toContain('3 were already in your vault.');
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
      NOTHING_SHARED_MESSAGE,
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
