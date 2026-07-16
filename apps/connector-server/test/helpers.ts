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
