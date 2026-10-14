#!/usr/bin/env node
/**
 * Fill a NorthKeep home with fictional demo projects and memories.
 *
 *   NORTHKEEP_HOME=/tmp/nk-demo \
 *   NORTHKEEP_DEMO_PASSPHRASE='horse battery demo only' \
 *   pnpm demo:seed
 *
 * The passphrase is read from the environment, never from the command line,
 * and it is not printed. NORTHKEEP_HOME is required: there is no default, so
 * a plain `pnpm demo:seed` cannot write into ~/.northkeep. If sync.json or
 * connector.json is already in that directory, the script exits before it
 * writes, so it cannot push demo text to a real account. Nothing here opens
 * a network connection.
 *
 * Run `pnpm build` once so the script can use the built server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const home = process.env.NORTHKEEP_HOME;
const passphrase = process.env.NORTHKEEP_DEMO_PASSPHRASE;
if (!home || !passphrase) {
  console.error('Set NORTHKEEP_HOME and NORTHKEEP_DEMO_PASSPHRASE (8 or more characters). Nothing was written.');
  process.exit(1);
}
if (passphrase.length < 8) {
  console.error('NORTHKEEP_DEMO_PASSPHRASE must be at least 8 characters. Nothing was written.');
  process.exit(1);
}
for (const name of ['sync.json', 'connector.json']) {
  if (fs.existsSync(path.join(home, name))) {
    console.error(name + ' is already in NORTHKEEP_HOME, so this demo was not written. Use a fresh directory.');
    process.exit(1);
  }
}

// The server must not see a real key grant, a scope limit, or a redaction
// tier that would call Ollama or refuse the write.
process.env.NORTHKEEP_NO_KEYCHAIN = '1';
process.env.NORTHKEEP_REDACT_TIER = '0';
delete process.env.NORTHKEEP_MASTER_KEY;
delete process.env.NORTHKEEP_SCOPES;
delete process.env.NORTHKEEP_PASSPHRASE;
delete process.env.NORTHKEEP_SECRET_BACKEND;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROJECTS = [
  {
    project: 'lantern-gazette',
    title: 'Lantern Hill Gazette',
    what_why: 'A fictional evening paper in the made-up town of Lantern Hill. Mara Quill is not a real person, and the paper has no subscribers.',
    status: 'The Thursday edition is laid out. The pear-festival brief is still a draft of a festival that does not exist.',
    next_actions: 'Invent a caption for the glass-orchard photograph.',
    milestones: 'M1 Lay out the Thursday edition | test: every page has a story\nM2 Write the festival brief | test: the brief reads as fiction',
  },
  {
    project: 'glass-orchard',
    title: 'Glass Orchard',
    what_why: 'A made-up orchard that grows glass pears for the Lantern Hill fair. The varieties are not real cultivars and have no grower.',
    status: 'Three fictional varieties are named. The clear-pear tasting note is not written yet.',
    next_actions: 'Write the tasting note for the clear-pear, and keep it fictional.',
    milestones: 'M1 Name three varieties | test: each has a made-up name\nM2 Write the tasting notes | test: one note per variety',
  },
  {
    project: 'river-post',
    title: 'River Post',
    what_why: 'A fictional ferry notice board for the invented crossing opposite Lantern Hill. The times are not a real schedule.',
    status: 'The Saturday crossing times are written down. They belong to the story, not to a river.',
    next_actions: 'Add a line that the fog bell is only a story.',
    milestones: 'none: a short fictional notice board with no plan',
  },
];

const MEMORIES = [
  {
    type: 'episodic',
    scope: 'lantern',
    content: '[demo] Mara Quill set the Lantern Hill Gazette masthead in green ink. This person, paper, and town are fictional.',
  },
  {
    type: 'semantic',
    scope: 'orchard',
    content: '[demo] The Glass Orchard clear-pear is a made-up fruit. It is not a real variety and has no grower.',
  },
  {
    type: 'procedural',
    scope: 'river',
    content: '[demo] When writing the River Post, keep every ferry time fictional. Do not use a real schedule or a real town.',
  },
];

function distUrl(relativePath) {
  const file = path.join(root, relativePath);
  if (!fs.existsSync(file)) {
    console.error('Missing ' + relativePath + '. Run pnpm build, then pnpm demo:seed. Nothing was written.');
    process.exit(1);
  }
  return pathToFileURL(file).href;
}

async function api(origin, token, route, options = {}) {
  const response = await fetch(origin + route, {
    method: options.method || 'GET',
    headers: {
      'X-NorthKeep-Token': token,
      ...(options.json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.json ? JSON.stringify(options.json) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || ('HTTP ' + response.status));
    error.status = response.status;
    throw error;
  }
  return data;
}

const { startUiServer } = await import(distUrl('apps/web/dist/server.js'));
const running = await startUiServer({ announce: false });
const page = new URL(running.url);
const token = page.searchParams.get('token');
const origin = page.origin;
let vaultCreated = false;
try {
  try {
    await api(origin, token, '/api/setup/create', { method: 'POST', json: { passphrase } });
    vaultCreated = true;
  } catch (error) {
    if (error.status !== 409) throw error;
    await api(origin, token, '/api/unlock', { method: 'POST', json: { passphrase } });
  }
  const existingMemories = await api(origin, token, '/api/memories');
  const have = new Set((existingMemories.memories || []).map((memory) => memory.content));
  let memoriesWritten = 0;
  for (const memory of MEMORIES) {
    if (have.has(memory.content)) continue;
    await api(origin, token, '/api/memories', { method: 'POST', json: memory });
    memoriesWritten += 1;
  }
  const existingProjects = await api(origin, token, '/api/projects');
  const projectSlugs = new Set((existingProjects.projects || []).map((project) => project.project));
  const missing = PROJECTS.filter((project) => !projectSlugs.has(project.project));
  await running.close();

  if (missing.length) {
    process.env.NORTHKEEP_PASSPHRASE = passphrase;
    const { createServer } = await import(distUrl('packages/mcp-server/dist/server.js'));
    const { defaultVaultPath } = await import(distUrl('packages/core/dist/index.js'));
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = createServer(defaultVaultPath());
    const client = new Client({ name: 'northkeep-demo', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      for (const project of missing) {
        const result = await client.callTool({ name: 'project_create', arguments: project });
        const text = (result.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        if (result.isError) throw new Error(text || 'project_create failed');
      }
    } finally {
      await client.close();
      await server.close();
      delete process.env.NORTHKEEP_PASSPHRASE;
    }
  }

  console.log(JSON.stringify({
    home,
    vault_created: vaultCreated,
    projects: PROJECTS.map((project) => project.project),
    memories_written: memoriesWritten,
    projects_written: missing.length,
  }));
} catch (error) {
  delete process.env.NORTHKEEP_PASSPHRASE;
  try { await running.close(); } catch { /* already closed */ }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
