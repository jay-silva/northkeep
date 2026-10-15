#!/usr/bin/env node
/**
 * Fill one connector account with the fictional sample vault.
 *
 * Nothing is read from the command line. Set these in the environment:
 *   NORTHKEEP_SEED_REVIEWER=1
 *   REVIEWER_CONNECTOR_TOKEN      at least 16 characters; never printed
 *   CONNECTOR_KEK_PEPPER          base64; the same value the connector uses
 *   DATABASE_URL                  the connector database, not the sync database
 *   NORTHKEEP_REVIEWER_CODE_FILE  a path outside this repo
 *
 * The pairing code is written only to that file, mode 0600. Re-running
 * overwrites the sample rows and mints a new code. If the account already
 * holds any row this seed did not write, nothing is changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.env.NORTHKEEP_SEED_REVIEWER !== '1') {
  fail('Set NORTHKEEP_SEED_REVIEWER=1 to confirm this write. Nothing was written.');
}
const token = process.env.REVIEWER_CONNECTOR_TOKEN ?? '';
if (token.trim().length < 16) {
  fail('Set REVIEWER_CONNECTOR_TOKEN to at least 16 characters. Nothing was written.');
}
if (!process.env.CONNECTOR_KEK_PEPPER) {
  fail('Set CONNECTOR_KEK_PEPPER to the connector pepper (base64). Nothing was written.');
}
const codeFile = process.env.NORTHKEEP_REVIEWER_CODE_FILE;
if (!codeFile) {
  fail('Set NORTHKEEP_REVIEWER_CODE_FILE to a path outside this repo. The pairing code is not printed. Nothing was written.');
}
const resolvedFile = path.resolve(codeFile);
const rootPrefix = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
if (resolvedFile === repoRoot || resolvedFile.startsWith(rootPrefix)) {
  fail('NORTHKEEP_REVIEWER_CODE_FILE must be outside the repository. Nothing was written.');
}
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
  fail('Set DATABASE_URL to the connector Postgres URL. Nothing was written.');
}

const dist = path.join(scriptDir, '..', 'dist', 'reviewer-seed.js');
if (!fs.existsSync(dist)) {
  fail('Missing apps/connector-server/dist/reviewer-seed.js. Run pnpm --filter @northkeep/connector-server build. Nothing was written.');
}

const { parseKekPepper } = await import(pathToFileURL(path.join(scriptDir, '..', 'dist', 'crypto.js')).href);
const { NeonConnectorStorage } = await import(pathToFileURL(path.join(scriptDir, '..', 'dist', 'neon-storage.js')).href);
const { seedReviewerAccount } = await import(pathToFileURL(dist).href);

let pepper;
try {
  pepper = parseKekPepper(process.env.CONNECTOR_KEK_PEPPER);
} catch (err) {
  fail(err instanceof Error ? err.message : 'CONNECTOR_KEK_PEPPER could not be read. Nothing was written.');
}
if (!pepper) fail('CONNECTOR_KEK_PEPPER is empty. Nothing was written.');

const storage = new NeonConnectorStorage(databaseUrl);
let seeded;
try {
  seeded = await seedReviewerAccount(storage, token, pepper);
} catch (err) {
  fail(err instanceof Error ? err.message : 'The sample vault was not written.');
}

const body = [
  'NorthKeep reviewer pairing code',
  'server: https://mcp.northkeep.ai/mcp',
  'legacy_server: https://northkeep-connector-server.vercel.app/mcp',
  `pairing_code: ${seeded.pairingCode}`,
  `expires_at: ${new Date(seeded.pairingExpiresAt).toISOString()}`,
  'single_use: yes',
  'This code is a secret. Do not commit it, paste it into a pull request, or put it in a log.',
  '',
].join('\n');
fs.mkdirSync(path.dirname(resolvedFile), { recursive: true });
fs.writeFileSync(resolvedFile, body, { mode: 0o600 });
fs.chmodSync(resolvedFile, 0o600);
console.log(`Sample rows written: ${seeded.rowsWritten}`);
console.log(`Account hash: ${seeded.accountHash}`);
console.log(`Pairing code written to ${resolvedFile}`);
