/**
 * Populate one connector account with a fictional sample vault for a directory
 * reviewer. Rows use ids that start with `sample-`. If the account already
 * holds any other row, nothing is written. Other accounts are never listed.
 *
 * The pairing code is single-use. Its lifetime is seven days so a reviewer
 * can connect after the operator runs this, which is longer than the ten
 * minute code a person gets from the app. The code is still stored only as
 * a hash, and the script that prints it writes the code to a file outside
 * the repo.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  DEV_KEK_PEPPER,
  KEK_LABEL_CONNECTOR_TOKEN,
  KEK_LABEL_PAIRING_CODE,
  deriveKek,
  encryptRow,
  generateDek,
  unwrapDekRotating,
  wrapDek,
} from './crypto.js';
import { generatePairingCode, sha256hex } from './hash.js';
import type { ConnectorStorage, SharedEntry } from './storage.js';

export const SAMPLE_ENTRY_PREFIX = 'sample-';
const PAIRING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ENTITLED_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_TOKEN_LENGTH = 16;

export interface SampleRow {
  entryId: string;
  scope: string;
  type: string;
  content: string;
}

export const SAMPLE_ROWS: readonly SampleRow[] = [
  {
    entryId: 'sample-memory-masthead',
    scope: 'lantern',
    type: 'episodic',
    content: 'Mara Quill set the Lantern Hill Gazette masthead in green ink. This person, paper, and town are fictional.',
  },
  {
    entryId: 'sample-memory-pear',
    scope: 'orchard',
    type: 'semantic',
    content: 'The Glass Orchard clear-pear is a made-up fruit. It is not a real variety and has no grower.',
  },
  {
    entryId: 'sample-memory-ferry',
    scope: 'river',
    type: 'procedural',
    content: 'When writing the River Post, keep every ferry time fictional. Do not use a real schedule or a real town.',
  },
  {
    entryId: 'sample-project-lantern-gazette',
    scope: 'project:lantern-gazette',
    type: 'working',
    content: [
      '## What & Why',
      '',
      'A fictional evening paper in the made-up town of Lantern Hill. Mara Quill is not a real person, and the paper has no subscribers.',
      '',
      '## Current Status',
      '',
      'The Thursday edition is laid out. The pear-festival brief is still a draft of a festival that does not exist.',
      '',
      '## Milestones',
      '',
      '- [ ] M1 Lay out the Thursday edition | test: every page has a story',
      '- [ ] M2 Write the festival brief | test: the brief reads as fiction',
      '',
      '## Next Actions',
      '',
      'Invent a caption for the glass-orchard photograph.',
      '',
      '## Decisions',
      '',
      '## Log',
      '',
    ].join('\n'),
  },
];

export interface ReviewerSeedResult {
  accountHash: string;
  pairingCode: string;
  pairingExpiresAt: number;
  rowsWritten: number;
}

export async function seedReviewerAccount(
  storage: ConnectorStorage,
  connectorToken: string,
  pepper: Uint8Array = DEV_KEK_PEPPER,
  now: number = Date.now(),
  previousPepper: Uint8Array | null = null,
): Promise<ReviewerSeedResult> {
  if (connectorToken.trim().length < MIN_TOKEN_LENGTH) {
    throw new Error('The reviewer connector token must be at least 16 characters. Nothing was written.');
  }
  const accountHash = sha256hex(connectorToken);
  const existing = await storage.listEntries(accountHash);
  if (existing.some((row) => !row.entryId.startsWith(SAMPLE_ENTRY_PREFIX))) {
    throw new Error('This account already holds rows this seed did not write. Nothing was changed.');
  }
  const tokenKek = await deriveKek(KEK_LABEL_CONNECTOR_TOKEN, connectorToken, pepper);
  const existingWrap = await storage.getAccountDekWrap(accountHash);
  let dek: Uint8Array;
  if (existingWrap) {
    const opened = await unwrapDekRotating(existingWrap, KEK_LABEL_CONNECTOR_TOKEN, connectorToken, pepper, previousPepper);
    dek = opened.dek;
    if (opened.usedPrevious) await storage.replaceAccountDekWrap(accountHash, existingWrap, await wrapDek(dek, tokenKek));
  } else {
    dek = await generateDek();
  }
  await storage.upsertAccount(accountHash);
  if (!existingWrap) await storage.ensureAccountDekWrap(accountHash, await wrapDek(dek, tokenKek));
  await storage.setEntitledUntil(accountHash, now + ENTITLED_MS);
  const createdAt = new Date(now).toISOString();
  for (const row of SAMPLE_ROWS) {
    const stored: SharedEntry = {
      entryId: row.entryId,
      scope: row.scope,
      type: '',
      content: await encryptRow({ accountHash, type: row.type, content: row.content }, dek),
      origin: 'vault',
      pending: false,
      writeSeq: 1,
      createdAt,
    };
    await storage.putEntry(accountHash, stored);
  }
  const pairingCode = generatePairingCode();
  const pairWrap = await wrapDek(dek, await deriveKek(KEK_LABEL_PAIRING_CODE, pairingCode, pepper));
  const pairingExpiresAt = now + PAIRING_TTL_MS;
  await storage.putPairingCode(sha256hex(pairingCode), accountHash, pairingExpiresAt, pairWrap);
  return { accountHash, pairingCode, pairingExpiresAt, rowsWritten: SAMPLE_ROWS.length };
}

export const REVIEWER_SEED_SECRET_ENV = 'NORTHKEEP_REVIEWER_SEED_SECRET';
const MIN_SEED_SECRET_LENGTH = 32;

/** The operator secret for POST /operator/reviewer-seed, or null (no route) when unset or too short. */
export function reviewerSeedSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[REVIEWER_SEED_SECRET_ENV]?.trim() ?? '';
  return raw.length >= MIN_SEED_SECRET_LENGTH ? raw : null;
}

/** Constant-time check of an `Authorization: Bearer` header against the operator secret. */
export function operatorBearerMatches(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(sha256hex(header.slice(7)), 'hex');
  const expected = Buffer.from(sha256hex(secret), 'hex');
  return timingSafeEqual(given, expected);
}
