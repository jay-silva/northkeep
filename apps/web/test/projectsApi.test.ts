import { describe, expect, it } from 'vitest';
import { handleProjectsApi } from '../src/projectsApi.js';
import { ProjectHandoffError } from '@northkeep/core';

describe('project API uncertain persistence', () => {
  it('does not return a receipt if saving fails, and does not save an exact replay again', async () => {
    const payload = Buffer.from(JSON.stringify({ vault_id: 'synthetic', operation_id: 'synthetic', expected_revision: 'synthetic', status: 'Ready', completed: 'Checked', next_actions: '' }));
    let saves = 0;
    const result = { replayed: false, receipt: { operation_id: 'synthetic' }, current: {} };
    const vault = { checkpointProject: () => result, save: () => { saves++; throw Object.assign(new Error('synthetic failure'), { code: 'EIO' }); } };
    const session = { isUnlocked: () => true, withVault: async (fn: (v: typeof vault) => unknown) => fn(vault) } as never;
    const response = await handleProjectsApi(session, 'POST', '/api/projects/sample/checkpoint', payload);
    expect(response?.status).toBe(500); expect(response?.body).not.toHaveProperty('receipt'); expect(saves).toBe(1);
    result.replayed = true;
    expect((await handleProjectsApi(session, 'POST', '/api/projects/sample/checkpoint', payload))?.status).toBe(200);
    expect(saves).toBe(1);
  });
});

describe('project edit and delete routes (owner requests 2026-09-13)', () => {
  function sessionFor(vault: Record<string, unknown>) {
    return { isUnlocked: () => true, withVault: async (fn: (v: typeof vault) => unknown) => fn(vault) } as never;
  }
  it('updates title and summary through a revision-bound plain update and saves once', async () => {
    const calls: unknown[] = []; let saves = 0;
    const vault = { updateProject: (request: unknown) => { calls.push(request); return { project: 'sample', title: 'Sample', status: 'Fixed' }; }, save: () => { saves++; } };
    const body = Buffer.from(JSON.stringify({ expected_revision: '11111111-1111-4111-8111-111111111111', title: 'Sample', status: 'Fixed' }));
    const response = await handleProjectsApi(sessionFor(vault), 'POST', '/api/projects/sample/update', body);
    expect(response?.status).toBe(200); expect(saves).toBe(1);
    expect(calls[0]).toEqual({ project: 'sample', expected_revision: '11111111-1111-4111-8111-111111111111', title: 'Sample', status: 'Fixed' });
  });
  it('refuses unknown fields, a missing revision, and non-string values without touching the vault', async () => {
    let touched = 0;
    const vault = { updateProject: () => { touched++; return {}; }, save: () => { touched++; } };
    for (const payload of [{ expected_revision: 'x', log_entry: 'nope' }, { title: 'No revision' }, { expected_revision: 'x', title: 5 }]) {
      const response = await handleProjectsApi(sessionFor(vault), 'POST', '/api/projects/sample/update', Buffer.from(JSON.stringify(payload)));
      expect(response?.status).toBe(400);
    }
    expect(touched).toBe(0);
  });
  it('deletes a project and reports the count; a missing project is 404', async () => {
    let saves = 0;
    const vault = { deleteProject: (project: string) => { if (project === 'gone') throw new ProjectHandoffError('not_found', 'Project was not found.'); return 3; }, save: () => { saves++; } };
    const ok = await handleProjectsApi(sessionFor(vault), 'DELETE', '/api/projects/sample', Buffer.alloc(0));
    expect(ok?.status).toBe(200); expect(ok?.body).toEqual({ project: 'sample', forgotten: 3 }); expect(saves).toBe(1);
    const missing = await handleProjectsApi(sessionFor(vault), 'DELETE', '/api/projects/gone', Buffer.alloc(0));
    expect(missing?.status).toBe(404); expect(saves).toBe(1);
    expect((await handleProjectsApi(sessionFor(vault), 'DELETE', '/api/projects/sample/checkpoint', Buffer.alloc(0)))?.status).toBe(405);
  });
});
