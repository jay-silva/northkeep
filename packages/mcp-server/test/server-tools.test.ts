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
let prevRedactionTier: string | undefined;
let client: Client | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-m13-'));
  vaultPath = path.join(home, 'vault.nkv');
  prevHome = process.env.NORTHKEEP_HOME;
  prevKey = process.env.NORTHKEEP_MASTER_KEY;
  prevScopes = process.env.NORTHKEEP_SCOPES;
  prevKeychain = process.env.NORTHKEEP_NO_KEYCHAIN;
  prevRedactionTier = process.env.NORTHKEEP_REDACT_TIER;
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
  if (prevRedactionTier === undefined) delete process.env.NORTHKEEP_REDACT_TIER;
  else process.env.NORTHKEEP_REDACT_TIER = prevRedactionTier;
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
        expected_revision: null,
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
      revision: string;
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
        expected_revision: createdPayload.revision,
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

  it('rolls the oldest Log entries into an archive memory instead of refusing, and project_get history returns it', async () => {
    const mcp = await connect();
    const long = (i: number) => `session ${i} ${'y'.repeat(700)}`;
    let revision: string | null = null;
    let lastPayload: { revision: string; content: string } | null = null;
    for (let i = 1; i <= 30; i += 1) {
      const res = await mcp.callTool({
        name: 'project_update',
        arguments: { project: 'demo-roll', expected_revision: revision, status: 'Rolling.', log_entry: long(i) },
      });
      expect(res.isError).toBeFalsy();
      lastPayload = JSON.parse(toolText(res)) as typeof lastPayload;
      revision = lastPayload!.revision;
    }
    expect(lastPayload!.content.length).toBeLessThanOrEqual(16384);
    expect(lastPayload!.content).toContain('session 30 ');
    expect(lastPayload!.content).not.toContain('session 1 y');

    const plain = JSON.parse(
      toolText(await mcp.callTool({ name: 'project_get', arguments: { project: 'demo-roll' } })),
    ) as { archives?: unknown };
    expect(plain.archives).toBeUndefined();
    const withHistory = JSON.parse(
      toolText(await mcp.callTool({ name: 'project_get', arguments: { project: 'demo-roll', history: true } })),
    ) as { archives: Array<{ content: string; id: string; updated_at: string }> };
    expect(withHistory.archives.length).toBeGreaterThan(0);
    expect(withHistory.archives[0]!.content.startsWith('## Log archive: demo-roll')).toBe(true);
    expect(withHistory.archives.map((a) => a.content).join('\n')).toContain('session 1 y');

    const vault = openVault();
    expect(vault.verifyChain().ok).toBe(true);
    vault.close();
  });

  it('reports duplicate live working docs as a conflict', async () => {
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
      projects: Array<{ project: string; status: string | null }>;
    };
    expect(listed.projects.filter((p) => p.project === 'dup')).toHaveLength(1);
    expect(listed.projects.find((p) => p.project === 'dup')?.status).toBeNull();

    const got = await mcp.callTool({ name: 'project_get', arguments: { project: 'dup' } });
    expect(got.isError).toBe(true);
    expect(JSON.parse(toolText(got)).error.code).toBe('project_conflict');
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
    expect(toolText(get)).toMatch(/outside this connection grant/);

    const update = await mcp.callTool({
      name: 'project_update',
      arguments: { project: 'secret', expected_revision: null, status: 'nope' },
    });
    expect(update.isError).toBe(true);
    expect(toolText(update)).toMatch(/outside this connection grant/);

    const vault = openVault();
    expect(vault.list({ scope: 'project:secret' })[0]?.content).toContain('Secret project.');
    vault.close();
  });

  it('refuses a project_update past the 16 KiB cap with a prune message', async () => {
    const mcp = await connect();
    const result = await mcp.callTool({
      name: 'project_update',
      arguments: { project: 'huge', expected_revision: null, status: 'z'.repeat(PROJECT_DOC_MAX_CHARS) },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain(PROJECT_DOC_CAP_MESSAGE);
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
        expected_revision: null,
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

  it('coordinates two clients with revision conflicts and idempotent checkpoint retries', async () => {
    const first = await connect();
    const secondServer = createServer(vaultPath);
    const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
    const second = new Client({ name: 'second-handoff-client', version: '1.0' });
    await Promise.all([second.connect(secondClientTransport), secondServer.connect(secondServerTransport)]);
    try {
      const created = JSON.parse(toolText(await first.callTool({
        name: 'project_update',
        arguments: { project: 'handoff', expected_revision: null, status: 'Ready.', next_actions: 'Continue.' },
      }))) as { revision: string; vault_id: string };
      const a = JSON.parse(toolText(await first.callTool({ name: 'project_resume', arguments: { project: 'handoff' } }))) as { revision: string; vault_id: string };
      const b = JSON.parse(toolText(await second.callTool({ name: 'project_resume', arguments: { project: 'handoff' } }))) as { revision: string };
      expect(a.revision).toBe(created.revision);
      expect(b.revision).toBe(created.revision);
      const request = {
        vault_id: a.vault_id, project: 'handoff', operation_id: '11111111-1111-4111-8111-111111111111',
        expected_revision: a.revision, status: 'Checkpointed.', completed: 'Finished integration.', next_actions: 'Review.',
      };
      const saved = JSON.parse(toolText(await first.callTool({ name: 'project_checkpoint', arguments: request }))) as { replayed: boolean; current: { revision: string } };
      expect(saved.replayed).toBe(false);
      const replayed = JSON.parse(toolText(await second.callTool({ name: 'project_checkpoint', arguments: request }))) as { replayed: boolean; current: { revision: string } };
      expect(replayed.replayed).toBe(true);
      expect(replayed.current.revision).toBe(saved.current.revision);
      const stale = await second.callTool({
        name: 'project_wrap',
        arguments: { ...request, operation_id: '22222222-2222-4222-8222-222222222222', completed: 'Stale wrap.' },
      });
      expect(stale.isError).toBe(true);
      const stalePayload = JSON.parse(toolText(stale)) as { error: { code: string; current: { revision: string } } };
      expect(stalePayload.error.code).toBe('stale_project');
      expect(stalePayload.error.current.revision).toBe(saved.current.revision);
    } finally {
      await second.close();
    }
  });

  it('enforces grants before handoff receipts and refuses Tier 1 project writes', async () => {
    const mcp = await connect();
    const created = JSON.parse(toolText(await mcp.callTool({
      name: 'project_update',
      arguments: {
        project: 'protected', expected_revision: null,
        status: 'AWS AKIAIOSFODNN7EXAMPLE rotated.', next_actions: '',
        files: [
          { type: 'local_path', label: 'Observed.txt', locator: '/tmp/observed.txt', access: 'reported_available', checked_at: '2026-09-10T12:00:00.000Z', context: 'Checked by the authoring assistant.' },
          { type: 'local_path', label: 'Missing.txt', locator: '/tmp/missing.txt', access: 'unavailable' },
        ],
      },
    }))) as { revision: string; vault_id: string };
    const receiverView = JSON.parse(toolText(await mcp.callTool({
      name: 'project_resume', arguments: { project: 'protected' },
    }))) as { files: Array<Record<string, unknown>>; file_access_note: string; files_text: string };
    expect(receiverView.files[0]).toMatchObject({ label: 'Observed.txt', access: 'unverified' });
    expect(receiverView.files[0]).not.toHaveProperty('checked_at');
    expect(receiverView.files[0]).not.toHaveProperty('context');
    expect(receiverView.files[1]).toMatchObject({ label: 'Missing.txt', access: 'unavailable' });
    expect(receiverView.file_access_note).toMatch(/checked again in this receiving environment/);
    expect(receiverView.files_text).toContain('reported_available');
    process.env.NORTHKEEP_SCOPES = 'personal';
    const denied = await mcp.callTool({
      name: 'project_checkpoint',
      arguments: {
        vault_id: created.vault_id, project: 'protected', operation_id: '33333333-3333-4333-8333-333333333333',
        expected_revision: created.revision, status: 'No.', completed: 'No.', next_actions: '',
      },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(toolText(denied)).error.code).toBe('scope_denied');
    process.env.NORTHKEEP_SCOPES = 'project:protected';
    process.env.NORTHKEEP_REDACT_TIER = '1';
    const resumed = toolText(await mcp.callTool({ name: 'project_resume', arguments: { project: 'protected' } }));
    expect(resumed).not.toContain('AKIAIOSFODNN7EXAMPLE');
    const refused = await mcp.callTool({
      name: 'project_update',
      arguments: { project: 'protected', expected_revision: created.revision, status: 'masked round trip' },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(toolText(refused)).error.code).toBe('invalid_request');
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
