/** Projects routes inherit server.ts session-token checks and require an unlocked vault. */
import fs from 'node:fs';
import { getProjectView, listProjectViews, northkeepHome, ProjectHandoffError, type ProjectCheckpointRequest, type ProjectUpdateRequest } from '@northkeep/core';
import { readMirrorSummary } from '@northkeep/mcp-server';
import type { UiSession } from './session.js';

/** Attribution for a save made from this app (ADR 0052 Decision 1). The host
 * name is fixed and the session id comes from the process, never the request:
 * a browser must not be able to claim it wrote as another host. */
const appWriter = (session: UiSession) => ({ host: 'northkeep-app', host_version: null, session_id: session.sessionId });
/** Attribution and draft state are server-owned, so a body may not carry them. */
const FORGED_FIELDS = ['writer', 'draft'];

interface Response { status: number; body: unknown }
const reply = (status: number, body: unknown): Response => ({ status, body });

/** The saved vault's size, or null when it cannot be read; never fails a completed save. */
function fileBytes(vaultPath: string): number | null {
  try { return fs.statSync(vaultPath).size; } catch { return null; }
}

/** ADR 0053 Decision 7: the backup line, or null. A status must never cost the project list. */
function mirrorSummary(vault: Parameters<typeof readMirrorSummary>[0]): string | null {
  try { return readMirrorSummary(vault, undefined, northkeepHome()); } catch { return null; }
}

export async function handleProjectsApi(session: UiSession, method: string, route: string, body: Buffer): Promise<Response | null> {
  if (route !== '/api/projects' && !route.startsWith('/api/projects/')) return null;
  try {
    if (!session.isUnlocked()) return reply(423, { error: 'Vault is locked.', code: 'locked' });
    if (method === 'GET' && route === '/api/projects') {
      return reply(200, await session.withVault(vault => ({ vault_id: vault.getVaultId(), projects: listProjectViews(vault), mirror: mirrorSummary(vault) })));
    }
    if (route === '/api/projects/compact') {
      // ADR 0051 Decision 2. Preview by default: the caller asks for a real run
      // with dry_run false, because blanked revision text does not come back.
      if (method !== 'POST') return reply(405, { error: 'Method not allowed.', code: 'invalid_request' });
      if (body.length > 4 * 1024) return reply(400, { error: 'Compaction request is too large.', code: 'invalid_request' });
      let input: Record<string, unknown> = {};
      if (body.length > 0) {
        try {
          const parsed: unknown = JSON.parse(body.toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          input = parsed as Record<string, unknown>;
        } catch { return reply(400, { error: 'A JSON object is required.', code: 'invalid_request' }); }
      }
      if (Object.keys(input).some(key => !['project', 'keep', 'dry_run'].includes(key))) return reply(400, { error: 'Unexpected compaction field.', code: 'invalid_request' });
      if (input.project !== undefined && (typeof input.project !== 'string' || !/^[a-z0-9-]{1,40}$/.test(input.project))) return reply(400, { error: 'project must be a project name.', code: 'invalid_request' });
      if (input.keep !== undefined && (typeof input.keep !== 'number' || !Number.isInteger(input.keep) || input.keep < 1 || input.keep > 1000)) return reply(400, { error: 'keep must be a whole number between 1 and 1000.', code: 'invalid_request' });
      if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') return reply(400, { error: 'dry_run must be true or false.', code: 'invalid_request' });
      const dryRun = input.dry_run !== false;
      try {
        return reply(200, await session.withVault(vault => {
          const result = vault.compactProjectHistory({
            ...(input.project !== undefined ? { project: input.project as string } : {}),
            ...(input.keep !== undefined ? { keep: input.keep as number } : {}),
            dryRun,
          });
          if (dryRun) return result;
          vault.save();
          return { ...result, file_bytes_after: fileBytes(vault.path) };
        }));
      } catch (error) {
        if (error instanceof Error && error.name === 'LockedError') throw error;
        // The vault is reopened per request and closed again, so a refusal here
        // left nothing behind: say what happened instead of advising a retry.
        return reply(500, { error: error instanceof Error ? error.message : 'Compaction failed.', code: 'compaction_failed' });
      }
    }
    const match = /^\/api\/projects\/([a-z0-9-]{1,40})(?:\/(checkpoint|wrap|update))?$/.exec(route);
    if (!match) return reply(404, { error: 'Project route not found.', code: 'not_found' });
    const project = match[1]!;
    if (method === 'GET' && !match[2]) {
      return reply(200, await session.withVault(vault => getProjectView(vault, project, undefined, { history: true })));
    }
    if (method === 'DELETE' && !match[2]) {
      // Owner request 2026-09-13: delete a project from the app. Forgets every
      // entry in the project scope (tombstones, chain intact) in one transaction.
      return reply(200, await session.withVault(vault => {
        const forgotten = vault.deleteProject(project);
        vault.save();
        return { project, forgotten };
      }));
    }
    if (method === 'POST' && match[2] === 'update') {
      // Owner request 2026-09-13: correct the title or summary in place. A
      // revision-bound plain update: no receipt, no log entry, new revision.
      if (body.length > 128 * 1024) return reply(400, { error: 'Project update is too large.', code: 'invalid_request' });
      let input: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        input = parsed as Record<string, unknown>;
      } catch { return reply(400, { error: 'A JSON object is required.', code: 'invalid_request' }); }
      const allowed = ['expected_revision', 'title', 'status', 'next_actions', 'what_why', 'open_questions'];
      if (FORGED_FIELDS.some(key => key in input)) return reply(400, { error: 'This field is set by NorthKeep and cannot be sent.', code: 'invalid_request' });
      if (Object.keys(input).some(key => !allowed.includes(key))) return reply(400, { error: 'Unexpected project update field.', code: 'invalid_request' });
      if (typeof input.expected_revision !== 'string') return reply(400, { error: 'expected_revision is required to edit an existing project.', code: 'invalid_request' });
      for (const key of ['title', 'status', 'next_actions', 'what_why', 'open_questions']) {
        if (input[key] !== undefined && typeof input[key] !== 'string') return reply(400, { error: `${key} must be a string.`, code: 'invalid_request' });
      }
      const request = { ...input, project, writer: appWriter(session) } as unknown as ProjectUpdateRequest;
      return reply(200, await session.withVault(vault => {
        const current = vault.updateProject(request);
        vault.save();
        return current;
      }));
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
    if (FORGED_FIELDS.some(key => key in input)) return reply(400, { error: 'This field is set by NorthKeep and cannot be sent.', code: 'invalid_request' });
    if (Object.keys(input).some(key => !allowed.includes(key))) return reply(400, { error: 'Unexpected project update field.', code: 'invalid_request' });
    const request = { ...input, project, mode: match[2], writer: appWriter(session) } as unknown as ProjectCheckpointRequest;
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
