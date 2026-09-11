/** Projects routes inherit server.ts session-token checks and require an unlocked vault. */
import { getProjectView, listProjectViews, ProjectHandoffError, type ProjectCheckpointRequest } from '@northkeep/core';
import type { UiSession } from './session.js';

interface Response { status: number; body: unknown }
const reply = (status: number, body: unknown): Response => ({ status, body });

export async function handleProjectsApi(session: UiSession, method: string, route: string, body: Buffer): Promise<Response | null> {
  if (route !== '/api/projects' && !route.startsWith('/api/projects/')) return null;
  try {
    if (!session.isUnlocked()) return reply(423, { error: 'Vault is locked.', code: 'locked' });
    if (method === 'GET' && route === '/api/projects') {
      return reply(200, await session.withVault(vault => ({ vault_id: vault.getVaultId(), projects: listProjectViews(vault) })));
    }
    const match = /^\/api\/projects\/([a-z0-9-]{1,40})(?:\/(checkpoint|wrap))?$/.exec(route);
    if (!match) return reply(404, { error: 'Project route not found.', code: 'not_found' });
    const project = match[1]!;
    if (method === 'GET' && !match[2]) {
      return reply(200, await session.withVault(vault => getProjectView(vault, project, undefined, { history: true })));
    }
    if (method !== 'POST' || !match[2]) return reply(405, { error: 'Method not allowed.', code: 'invalid_request' });
    if (body.length > 128 * 1024) return reply(400, { error: 'Project update is too large.', code: 'invalid_request' });
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      input = parsed as Record<string, unknown>;
    } catch { return reply(400, { error: 'A JSON object is required.', code: 'invalid_request' }); }
    const allowed = ['vault_id', 'operation_id', 'expected_revision', 'status', 'completed', 'next_actions', 'decision', 'open_questions', 'files'];
    if (Object.keys(input).some(key => !allowed.includes(key))) return reply(400, { error: 'Unexpected project update field.', code: 'invalid_request' });
    const request = { ...input, project, mode: match[2] } as unknown as ProjectCheckpointRequest;
    return reply(200, await session.withVault(vault => {
      const result = vault.checkpointProject(request);
      if (!result.replayed) vault.save();
      return result;
    }));
  } catch (error) {
    if (error instanceof ProjectHandoffError) {
      const status = error.code === 'invalid_request' ? 400 : error.code === 'not_found' ? 404 : error.code === 'scope_denied' ? 403 : 409;
      return reply(status, { error: error.message, code: error.code, ...(error.current ? { current: error.current } : {}) });
    }
    if (error instanceof Error && error.name === 'LockedError') return reply(423, { error: 'Vault is locked.', code: 'locked' });
    return reply(500, { error: 'The save could not be confirmed. Retry the same update to check its result.', code: 'save_uncertain' });
  }
}
