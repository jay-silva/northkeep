import { describe, expect, it } from 'vitest';
import { handleProjectsApi } from '../src/projectsApi.js';

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
