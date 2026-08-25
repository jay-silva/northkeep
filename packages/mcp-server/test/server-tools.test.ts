import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  KDF_INTERACTIVE,
  PROJECT_DOC_CAP_MESSAGE,
  PROJECT_DOC_MAX_CHARS,
  Vault,
  deriveMasterKey,
  generateDeviceSecret,
  parseProjectDoc,
  getProjectSection,
} from '@northkeep/core';
import { readCallLog } from '../src/log.js';
import {
  PROJECT_HONESTY_NOTE,
  PROJECT_STANDING_INSTRUCTION,
} from '../src/project-recipe.js';
import { createServer } from '../src/server.js';

const PASSPHRASE = 'm13 server-tools passphrase';

let home: string;
let vaultPath: string;
let prevHome: string | undefined;
let prevKey: string | undefined;
let prevScopes: string | undefined;
let prevKeychain: string | undefined;
let client: Client | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-m13-'));
  vaultPath = path.join(home, 'vault.nkv');
  prevHome = process.env.NORTHKEEP_HOME;
  prevKey = process.env.NORTHKEEP_MASTER_KEY;
  prevScopes = process.env.NORTHKEEP_SCOPES;
  prevKeychain = process.env.NORTHKEEP_NO_KEYCHAIN;
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  delete process.env.NORTHKEEP_SCOPES;

  const deviceSecret = generateDeviceSecret();
  const vault = Vault.create({
    path: vaultPath,
    passphrase: PASSPHRASE,
    deviceSecret,
    kdf: KDF_INTERACTIVE,
  });
  vault.close();
  const header = Vault.readHeader(vaultPath);
  const key = deriveMasterKey(PASSPHRASE, deviceSecret, header.salt, header.kdf);
  process.env.NORTHKEEP_MASTER_KEY = key.toString('hex');
});

afterEach(async () => {
  if (client) {
    await client.close().catch(() => undefined);
    client = undefined;
  }
  if (prevHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prevHome;
  if (prevKey === undefined) delete process.env.NORTHKEEP_MASTER_KEY;
  else process.env.NORTHKEEP_MASTER_KEY = prevKey;
  if (prevScopes === undefined) delete process.env.NORTHKEEP_SCOPES;
  else process.env.NORTHKEEP_SCOPES = prevScopes;
  if (prevKeychain === undefined) delete process.env.NORTHKEEP_NO_KEYCHAIN;
  else process.env.NORTHKEEP_NO_KEYCHAIN = prevKeychain;
  fs.rmSync(home, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const server = createServer(vaultPath);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'm13-test', version: '1.0' });
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  client = mcp;
  return mcp;
}

function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
}

function openVault(): Vault {
  return Vault.openWithKey(vaultPath, Buffer.from(process.env.NORTHKEEP_MASTER_KEY!, 'hex'));
}

describe('memory_edit', () => {
  it('a scoped grant cannot edit outside its scopes', async () => {
    const seeded = (() => {
      const vault = openVault();
      const personal = vault.remember({ content: 'private fact', type: 'semantic', scope: 'personal' });
      const work = vault.remember({ content: 'work fact', type: 'semantic', scope: 'work' });
      vault.save();
      vault.close();
      return { personal, work };
    })();

    process.env.NORTHKEEP_SCOPES = 'work';
    const mcp = await connect();
    const denied = await mcp.callTool({
      name: 'memory_edit',
      arguments: { id: seeded.personal.id, content: 'should not land' },
    });
    expect(denied.isError).toBe(true);
    expect(toolText(denied)).toMatch(/No memory found/);

    const ok = await mcp.callTool({
      name: 'memory_edit',
      arguments: { id: seeded.work.id, content: 'work fact v2' },
    });
    expect(ok.isError).toBeFalsy();
    const payload = JSON.parse(toolText(ok)) as { edited: { content: string; scope: string } };
    expect(payload.edited.content).toBe('work fact v2');
    expect(payload.edited.scope).toBe('work');

    const vault = openVault();
    expect(vault.list().find((e) => e.scope === 'personal')?.content).toBe('private fact');
    vault.close();
  });

  it('ignores a forged extra scope and does not move the memory', async () => {
    const original = (() => {
      const vault = openVault();
      const entry = vault.remember({ content: 'stays in work', type: 'semantic', scope: 'work' });
      vault.save();
      vault.close();
      return entry;
    })();

    const mcp = await connect();
    const result = await mcp.callTool({
      name: 'memory_edit',
      arguments: { id: original.id, content: 'still in work', scope: 'personal' } as never,
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(toolText(result)) as { edited: { scope: string; content: string } };
    expect(payload.edited.scope).toBe('work');
    expect(payload.edited.content).toBe('still in work');
  });

  it('keeps the superseded original and the provenance chain intact', async () => {
    const original = (() => {
      const vault = openVault();
      const entry = vault.remember({ content: 'takes coffee with milk', type: 'semantic', scope: 'personal' });
      vault.save();
      vault.close();
      return entry;
    })();

    const mcp = await connect();
    const result = await mcp.callTool({
      name: 'memory_edit',
      arguments: { id: original.id, content: 'takes coffee black' },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(toolText(result)) as { edited: { id: string; content: string } };
    expect(payload.edited.id).not.toBe(original.id);
    expect(payload.edited.content).toBe('takes coffee black');

    const vault = openVault();
    expect(vault.list()).toHaveLength(1);
    const history = vault.list({ includeSuperseded: true });
    expect(history).toHaveLength(2);
    const old = history.find((e) => e.id === original.id)!;
    expect(old.superseded_by).toBe(payload.edited.id);
    expect(old.content).toBe('takes coffee with milk');
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });

  it('refuses to edit a superseded or forgotten id', async () => {
    const ids = (() => {
      const vault = openVault();
      const live = vault.remember({ content: 'v1', type: 'semantic', scope: 'personal' });
      const replacement = vault.editMemory(live.id, { content: 'v2' });
      const doomed = vault.remember({ content: 'forget me', type: 'semantic', scope: 'personal' });
      vault.forget(doomed.id);
      vault.save();
      vault.close();
      return { superseded: live.id, forgotten: doomed.id, live: replacement.id };
    })();

    const mcp = await connect();
    const superseded = await mcp.callTool({
      name: 'memory_edit',
      arguments: { id: ids.superseded, content: 'nope' },
    });
    expect(superseded.isError).toBe(true);
    expect(toolText(superseded)).toMatch(/No memory found/);

    const forgotten = await mcp.callTool({
      name: 'memory_edit',
      arguments: { id: ids.forgotten, content: 'nope' },
    });
    expect(forgotten.isError).toBe(true);
    expect(toolText(forgotten)).toMatch(/No memory found/);

    const vault = openVault();
    expect(vault.list().find((e) => e.id === ids.live)?.content).toBe('v2');
    vault.close();
  });

  it('audits content-free (id and scopes, never body text)', async () => {
    const original = (() => {
      const vault = openVault();
      const entry = vault.remember({
        content: 'SECRET-BODY-SHOULD-NOT-LOG',
        type: 'semantic',
        scope: 'personal',
      });
      vault.save();
      vault.close();
      return entry;
    })();

    const mcp = await connect();
    await mcp.callTool({
      name: 'memory_edit',
      arguments: { id: original.id, content: 'OTHER-SECRET-BODY' },
    });
    const log = fs.readFileSync(path.join(home, 'mcp-calls.log'), 'utf8');
    expect(log).toContain('memory_edit');
    expect(log).toContain(original.id);
    expect(log).not.toContain('SECRET-BODY');
    expect(log).not.toContain('OTHER-SECRET');
    const rows = readCallLog();
    const edit = rows.find((r) => r.tool === 'memory_edit');
    expect(edit?.ok).toBe(true);
    expect(edit?.result_id).toBeDefined();
    expect(edit?.disclosed_scopes).toEqual(['personal']);
  });
});

describe('project tools', () => {
  it('creates, lists, gets, and merge-updates a project', async () => {
    const mcp = await connect();
    const created = await mcp.callTool({
      name: 'project_update',
      arguments: {
        project: 'demo-m13',
        what_why: 'Prove cold-start handoff.',
        status: 'Writing the tools.',
        next_actions: '- [ ] Verify in Claude Desktop',
        log_entry: 'Created the project.',
        decision: 'Derived index, no stored INDEX.',
      },
    });
    expect(created.isError).toBeFalsy();
    const createdPayload = JSON.parse(toolText(created)) as {
      created: boolean;
      project: string;
      scope: string;
      type: string;
      content: string;
    };
    expect(createdPayload.created).toBe(true);
    expect(createdPayload.scope).toBe('project:demo-m13');
    expect(createdPayload.type).toBe('working');

    const listed = JSON.parse(toolText(await mcp.callTool({ name: 'project_list', arguments: {} }))) as {
      projects: Array<{ project: string; status: string; scope: string }>;
    };
    expect(listed.projects).toHaveLength(1);
    expect(listed.projects[0]).toMatchObject({
      project: 'demo-m13',
      scope: 'project:demo-m13',
      status: 'Writing the tools.',
    });

    const got = JSON.parse(
      toolText(await mcp.callTool({ name: 'project_get', arguments: { project: 'demo-m13' } })),
    ) as { content: string; id: string };
    expect(got.content).toContain('Prove cold-start handoff.');
    expect(got.content).toContain('Created the project.');

    const updated = await mcp.callTool({
      name: 'project_update',
      arguments: {
        project: 'demo-m13',
        status: 'Tools landed.',
        next_actions: '- [ ] Run acceptance',
        log_entry: 'Merged a session-end update.',
      },
    });
    expect(updated.isError).toBeFalsy();
    const updatedPayload = JSON.parse(toolText(updated)) as { created: boolean; id: string; content: string };
    expect(updatedPayload.created).toBe(false);
    expect(updatedPayload.id).not.toBe(got.id);

    const doc = parseProjectDoc(updatedPayload.content);
    expect(getProjectSection(doc, 'What & Why')).toBe('Prove cold-start handoff.');
    expect(getProjectSection(doc, 'Current Status')).toBe('Tools landed.');
    expect(getProjectSection(doc, 'Next Actions')).toBe('- [ ] Run acceptance');
    expect(getProjectSection(doc, 'Log').startsWith('- ')).toBe(true);
    expect(getProjectSection(doc, 'Log')).toContain('Merged a session-end update.');
    expect(getProjectSection(doc, 'Log')).toContain('Created the project.');
    expect(getProjectSection(doc, 'Decisions')).toContain('Derived index');

    const vault = openVault();
    expect(vault.list({ scope: 'project:demo-m13', type: 'working' })).toHaveLength(1);
    expect(vault.list({ scope: 'project:demo-m13', type: 'working', includeSuperseded: true }).length).toBe(2);
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });

  it('resolves duplicate live working docs to the newest', async () => {
    (() => {
      const vault = openVault();
      vault.remember({
        content: '## Current Status\n\nOlder duplicate.\n',
        type: 'working',
        scope: 'project:dup',
      });
      vault.remember({
        content: '## Current Status\n\nNewest wins.\n',
        type: 'working',
        scope: 'project:dup',
      });
      vault.save();
      vault.close();
    })();

    const mcp = await connect();
    const listed = JSON.parse(toolText(await mcp.callTool({ name: 'project_list', arguments: {} }))) as {
      projects: Array<{ project: string; status: string }>;
    };
    expect(listed.projects.filter((p) => p.project === 'dup')).toHaveLength(1);
    expect(listed.projects.find((p) => p.project === 'dup')?.status).toBe('Newest wins.');

    const got = JSON.parse(
      toolText(await mcp.callTool({ name: 'project_get', arguments: { project: 'dup' } })),
    ) as { content: string };
    expect(got.content).toContain('Newest wins.');
    expect(got.content).not.toContain('Older duplicate.');
  });

  it('denies project_get and project_update outside the grant', async () => {
    (() => {
      const vault = openVault();
      vault.remember({
        content: '## Current Status\n\nSecret project.\n',
        type: 'working',
        scope: 'project:secret',
      });
      vault.save();
      vault.close();
    })();

    process.env.NORTHKEEP_SCOPES = 'personal';
    const mcp = await connect();
    const listed = JSON.parse(toolText(await mcp.callTool({ name: 'project_list', arguments: {} }))) as {
      projects: unknown[];
    };
    expect(listed.projects).toEqual([]);

    const get = await mcp.callTool({ name: 'project_get', arguments: { project: 'secret' } });
    expect(get.isError).toBe(true);
    expect(toolText(get)).toMatch(/not granted/);

    const update = await mcp.callTool({
      name: 'project_update',
      arguments: { project: 'secret', status: 'nope' },
    });
    expect(update.isError).toBe(true);
    expect(toolText(update)).toMatch(/not granted/);

    const vault = openVault();
    expect(vault.list({ scope: 'project:secret' })[0]?.content).toContain('Secret project.');
    vault.close();
  });

  it('refuses a project_update past the 16 KiB cap with a prune message', async () => {
    const mcp = await connect();
    const result = await mcp.callTool({
      name: 'project_update',
      arguments: { project: 'huge', status: 'z'.repeat(PROJECT_DOC_MAX_CHARS) },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toBe(PROJECT_DOC_CAP_MESSAGE);
    const vault = openVault();
    expect(vault.list({ scope: 'project:huge' })).toHaveLength(0);
    vault.close();
  });

  it('audits project tools content-free', async () => {
    const mcp = await connect();
    await mcp.callTool({
      name: 'project_update',
      arguments: {
        project: 'auditme',
        status: 'UNIQUE-STATUS-PHRASE',
        log_entry: 'UNIQUE-LOG-PHRASE',
      },
    });
    await mcp.callTool({ name: 'project_get', arguments: { project: 'auditme' } });
    await mcp.callTool({ name: 'project_list', arguments: {} });
    const raw = fs.readFileSync(path.join(home, 'mcp-calls.log'), 'utf8');
    expect(raw).not.toContain('UNIQUE-STATUS-PHRASE');
    expect(raw).not.toContain('UNIQUE-LOG-PHRASE');
    const rows = readCallLog();
    expect(rows.find((r) => r.tool === 'project_update')?.disclosed_scopes).toEqual(['project:auditme']);
    expect(rows.find((r) => r.tool === 'project_get')?.disclosed_scopes).toEqual(['project:auditme']);
    expect(rows.find((r) => r.tool === 'project_list')?.result_count).toBe(1);
  });
});

describe('project standing-instruction copy', () => {
  function expectSteeringClean(text: string): void {
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(/https?:|www\./i);
    expect(text).not.toMatch(/subscribe\b/i);
    expect(text).not.toMatch(/[—–]/);
  }

  it('has no em dashes and no steering', () => {
    expectSteeringClean(PROJECT_STANDING_INSTRUCTION);
    expectSteeringClean(PROJECT_HONESTY_NOTE);
    expect(PROJECT_STANDING_INSTRUCTION).toContain('project_get');
    expect(PROJECT_STANDING_INSTRUCTION).toContain('project_update');
    expect(PROJECT_STANDING_INSTRUCTION).toContain('project_list');
  });
});
