import type { ConnectorStorage, SharedEntry } from '../src/storage.js';
import {
  DEV_KEK_PEPPER,
  KEK_LABEL_CONNECTOR_TOKEN,
  decryptRow,
  deriveKek,
  encryptRow,
  generateDek,
  isEncryptedRow,
  unwrapDek,
  wrapDek,
} from '../src/crypto.js';

/**
 * Tests run over InMemory storage with no CONNECTOR_KEK_PEPPER set, so the
 * server falls back to DEV_KEK_PEPPER. These helpers derive KEKs with the SAME
 * pepper so their wraps interoperate with the server's.
 */
const TEST_PEPPER = DEV_KEK_PEPPER;

/**
 * ADR 0020 test helpers. Since encryption-at-rest, `shared_entries.content` is
 * ciphertext: a test that seeds via storage.putEntry must ENCRYPT first (the
 * server would never store plaintext), and a test that inspects stored rows
 * must decrypt them. Both sides resolve the account DEK exactly the way the
 * server does — from the plaintext connector token the test already holds.
 */

/** Resolve (or first-create) the account DEK the way the server does. */
export async function testAccountDek(
  storage: ConnectorStorage,
  accountHash: string,
  connToken: string,
): Promise<Uint8Array> {
  const kek = await deriveKek(KEK_LABEL_CONNECTOR_TOKEN, connToken, TEST_PEPPER);
  await storage.upsertAccount(accountHash);
  const existing = await storage.getAccountDekWrap(accountHash);
  if (existing) return unwrapDek(existing, kek);
  const winner = await storage.ensureAccountDekWrap(accountHash, await wrapDek(await generateDek(), kek));
  return unwrapDek(winner, kek);
}

/** Seed one row AS THE SERVER WOULD STORE IT: encrypted envelope, type column ''. */
export async function seedEncryptedEntry(
  storage: ConnectorStorage,
  accountHash: string,
  connToken: string,
  entry: SharedEntry,
): Promise<void> {
  const dek = await testAccountDek(storage, accountHash, connToken);
  await storage.putEntry(accountHash, {
    ...entry,
    type: '',
    content: await encryptRow({ accountHash, type: entry.type, content: entry.content }, dek),
  });
}

/** Decrypt a list of stored rows back to their plaintext view. */
export async function decryptEntryList(
  storage: ConnectorStorage,
  accountHash: string,
  connToken: string,
  rows: SharedEntry[],
): Promise<SharedEntry[]> {
  const dek = await testAccountDek(storage, accountHash, connToken);
  return Promise.all(
    rows.map(async (e) => {
      if (!isEncryptedRow(e.content)) return e;
      const plain = await decryptRow(e.content, accountHash, dek);
      return { ...e, type: plain.type, content: plain.content };
    }),
  );
}

/** storage.listEntries with plaintext restored. */
export async function decryptedEntries(
  storage: ConnectorStorage,
  accountHash: string,
  connToken: string,
): Promise<SharedEntry[]> {
  return decryptEntryList(storage, accountHash, connToken, await storage.listEntries(accountHash));
}

/** storage.listPendingEntries with plaintext restored. */
export async function decryptedPendingEntries(
  storage: ConnectorStorage,
  accountHash: string,
  connToken: string,
): Promise<SharedEntry[]> {
  return decryptEntryList(storage, accountHash, connToken, await storage.listPendingEntries(accountHash));
}

/**
 * Run the full pair -> register -> authorize -> consent -> token dance against a
 * running connector and return an MCP access token. Tests that drive real tool
 * calls need a real token; there is no shortcut past the OAuth flow.
 */
export async function connectAiApp(base: string, deviceSecret: Uint8Array): Promise<string> {
  const { startPairing } = await import('@northkeep/sync');
  const crypto = await import('node:crypto');
  const b64url = (b: Buffer): string => b.toString('base64url');
  const redirectUri = 'http://localhost:9999/callback';
  const resource = `${base}/mcp`;
  const pairingCode = await startPairing({ server: base, deviceSecret: deviceSecret as never });
  const as = (await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json())) as {
    registration_endpoint: string;
  };
  const reg = (await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'nk-test-client',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    }),
  }).then((r) => r.json())) as { client_id: string };
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(8));
  const authUrl = new URL(`${base}/authorize`);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp',
    state,
    resource,
  }).toString();
  await fetch(authUrl);
  const consent = await fetch(`${base}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      state,
      scope: 'mcp',
      resource,
      pairing_code: pairingCode,
    }).toString(),
  });
  const location = consent.headers.get('location');
  const code = location ? new URL(location).searchParams.get('code') : '';
  const tok = (await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: redirectUri,
      client_id: reg.client_id,
      code_verifier: verifier,
      resource,
    }),
  }).then((r) => r.json())) as { access_token?: string };
  return tok.access_token ?? '';
}

/** One tool call over POST /mcp, returning the first text block. */
export async function mcpToolCall(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const resp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const ct = resp.headers.get('content-type') || '';
  const raw = await resp.text();
  let msg: any = null;
  if (ct.includes('text/event-stream')) {
    const line = raw.split('\n').find((l) => l.startsWith('data:'));
    msg = line ? JSON.parse(line.slice(5).trim()) : null;
  } else {
    try {
      msg = JSON.parse(raw);
    } catch {
      msg = null;
    }
  }
  return {
    text: msg?.result?.content?.[0]?.text || msg?.error?.message || '',
    isError: msg?.result?.isError === true || Boolean(msg?.error),
  };
}
