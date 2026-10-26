import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { testAccountDek } from './helpers.js';

/**
 * GHSA-46jr-4wx8-v453: the SDK validates every array element and object key in
 * a tool call's arguments, so one large call could exhaust the server's memory.
 * The connector caps the count; ordinary calls are unaffected.
 */

let storage: InMemoryConnectorStorage;

beforeEach(() => {
  storage = new InMemoryConnectorStorage();
});

async function call(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const dek = await testAccountDek(storage, 'acct-input-cap', 'conn-token-input-cap');
  const server = createMcpServer(storage, 'acct-input-cap', dek);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'input-cap-test', version: '0.0.0' });
  await c.connect(b);
  try {
    const res = (await c.callTool({ name: 'memory_retrieve', arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: res.content[0]?.text ?? '', isError: res.isError === true };
  } catch (err) {
    return { text: (err as Error).message, isError: true };
  }
}

describe('tool input element cap', () => {
  it('answers an ordinary call', async () => {
    const res = await call({ query: 'anything' });
    expect(res.isError).toBe(false);
  });

  it('refuses a call whose arguments hold more than 1000 elements', async () => {
    const res = await call({ query: 'anything', padding: Array.from({ length: 1001 }, () => 0) });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('more than the maximum of 1000 elements');
  });

  it('counts object keys as well as array elements', async () => {
    const padding = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`k${i}`, i]));
    const res = await call({ query: 'anything', padding });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('more than the maximum of 1000 elements');
  });

  it('refuses a 200,000-element call', async () => {
    const res = await call({ query: 'anything', padding: Array.from({ length: 200_000 }, () => [0]) });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('more than the maximum of 1000 elements');
  });
});
