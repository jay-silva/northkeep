/** Projects routes inherit server.ts session-token checks and require an unlocked vault. */
import fs from 'node:fs';
import { getProjectView, listProjectOverview, loadDeviceSecret, MilestoneError, northkeepHome, PROJECT_REVISION_SUMMARY_LIMIT, ProjectHandoffError, projectScope, readProjectProvenance, type ProjectCheckpointRequest, type ProjectUpdateRequest, type ProjectView, type Vault } from '@northkeep/core';
import { confirmPassInDocument } from '@northkeep/core/project-milestones-owner';
import { loadConnectorConfig, unshareScope } from '@northkeep/sync';
import { readMirrorSummary } from '@northkeep/mcp-server';
import type { UiSession } from './session.js';
import { milestoneRepairText, passesUndoneByRestore, previewMilestoneRepair } from './project-milestones-view.js';

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

/**
 * ADR 0063 D4: saved versions whose text compaction blanked (ADR 0051). The
 * project view leaves them out; the page lists them as versions that cannot be
 * restored, with the writer that compaction keeps.
 */
function clearedRevisions(vault: Vault, project: string): Array<{ id: string; updated_at: string; writer: { host: string; host_version: string | null } | null }> {
  return vault.list({ scope: projectScope(project), type: 'working', includeSuperseded: true, includeForgotten: true })
    .filter(row => row.forgotten_at !== null && row.superseded_at !== null)
    .reverse()
    .slice(0, PROJECT_REVISION_SUMMARY_LIMIT)
    .map(row => {
      const writer = readProjectProvenance(row);
      return { id: row.id, updated_at: row.created_at, writer: writer ? { host: writer.host, host_version: writer.host_version } : null };
    });
}

/** ADR 0065 K2: what the project page needs to show and guard milestones. */
function milestoneFields(view: ProjectView) {
  const milestones = view.milestones;
  const undoes: Record<string, ReturnType<typeof passesUndoneByRestore>> = {};
  for (const revision of view.history) if (revision.content) undoes[revision.id] = passesUndoneByRestore(view.content, revision.content);
  return { milestones, restore_undoes: undoes, ...(milestones.kind === 'malformed' ? { milestone_repair_text: milestoneRepairText(view.content) } : {}) };
}

function jsonObject(body: Buffer, limit: number, what: string): { input: Record<string, unknown> } | { refused: Response } {
  if (body.length > limit) return { refused: reply(400, { error: `${what} is too large.`, code: 'invalid_request' }) };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return { input: parsed as Record<string, unknown> };
  } catch { return { refused: reply(400, { error: 'A JSON object is required.', code: 'invalid_request' }) }; }
}

/** The page's read must still be the head, so a stale page writes nothing. */
function headAsRead(vault: Vault, project: string, expected: string): ProjectView {
  const view = getProjectView(vault, project);
  if (view.revision !== expected) throw new ProjectHandoffError('stale_project', 'Project changed after it was read.', view);
  return view;
}

/**
 * ADR 0065 Decision 3: Mark passed and Confirm stamp (you) through
 * confirmPass; repair replaces a malformed section once Jay has seen every
 * line it would record as passed. Both are owner writes bound to the read.
 */
async function handleMilestoneWrite(session: UiSession, method: string, project: string, action: 'confirm' | 'repair', body: Buffer): Promise<Response> {
  if (method !== 'POST') return reply(405, { error: 'Method not allowed.', code: 'invalid_request' });
  const parsed = jsonObject(body, 16 * 1024, 'Milestone request');
  if ('refused' in parsed) return parsed.refused;
  const input = parsed.input;
  const allowed = action === 'confirm' ? ['id', 'expected_revision'] : ['body', 'expected_revision', 'check', 'accept_passes'];
  if (Object.keys(input).some(key => !allowed.includes(key))) return reply(400, { error: 'Unexpected milestone field.', code: 'invalid_request' });
  if (typeof input.expected_revision !== 'string') return reply(400, { error: 'expected_revision is required.', code: 'invalid_request' });
  const expected = input.expected_revision;
  const source = action === 'confirm' ? 'northkeep:milestone-confirm' : 'northkeep:milestone-repair';
  if (action === 'confirm') {
    if (typeof input.id !== 'string') return reply(400, { error: 'id is required.', code: 'invalid_request' });
    const id = input.id;
    return reply(200, await session.withVault(vault => {
      const view = headAsRead(vault, project, expected);
      const { content, passed } = confirmPassInDocument(view.content, id, new Date().toISOString());
      const current = vault.replaceProjectContent({ project, expected_revision: view.revision, content, source, writer: appWriter(session) }, { actor: 'owner' });
      vault.save();
      return { passed: { id: passed.id, title: passed.title, on: passed.on, by: passed.by }, current: { ...current, ...milestoneFields(current) } };
    }));
  }
  if (typeof input.body !== 'string') return reply(400, { error: 'body is required.', code: 'invalid_request' });
  if (input.check !== undefined && typeof input.check !== 'boolean') return reply(400, { error: 'check must be true or false.', code: 'invalid_request' });
  const accepted = input.accept_passes;
  if (accepted !== undefined && (!Array.isArray(accepted) || accepted.some(id => typeof id !== 'string'))) return reply(400, { error: 'accept_passes must be a list of milestone ids.', code: 'invalid_request' });
  const text = input.body;
  return reply(200, await session.withVault(vault => {
    const view = headAsRead(vault, project, expected);
    if (view.milestones.kind !== 'malformed') throw new MilestoneError('The Milestones section can be read, so there is nothing to repair. Reload the project.');
    const preview = previewMilestoneRepair(view.content, text);
    if (!preview.ok) throw new MilestoneError(preview.reason);
    const passes = preview.passes;
    if (input.check !== false) return { check: true, plan: preview.plan, passes };
    // Jay must have seen exactly the passes this text records, so a stamp typed in by someone else is not saved unseen.
    if (accepted === undefined || accepted.length !== passes.length || passes.some((pass, i) => accepted[i] !== pass.id)) {
      throw new MilestoneError('Check the milestones again before saving: the lines that count as passed are not the ones you reviewed.');
    }
    const current = vault.replaceProjectContent({ project, expected_revision: view.revision, content: preview.content, source, writer: appWriter(session) }, { actor: 'owner' });
    vault.save();
    return { check: false, passes, current: { ...current, ...milestoneFields(current) } };
  }));
}

export async function handleProjectsApi(session: UiSession, method: string, route: string, body: Buffer): Promise<Response | null> {
  if (route !== '/api/projects' && !route.startsWith('/api/projects/')) return null;
  try {
    if (!session.isUnlocked()) return reply(423, { error: 'Vault is locked.', code: 'locked' });
    if (method === 'GET' && route === '/api/projects') {
      return reply(200, await session.withVault(vault => {
        const shared = new Set(vault.sharedScopes());
        return { vault_id: vault.getVaultId(), projects: listProjectOverview(vault).map(project => ({ ...project, shared: shared.has(project.scope) })), mirror: mirrorSummary(vault) };
      }));
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
    const milestoneRoute = /^\/api\/projects\/([a-z0-9-]{1,40})\/milestones\/(confirm|repair)$/.exec(route);
    if (milestoneRoute) return await handleMilestoneWrite(session, method, milestoneRoute[1]!, milestoneRoute[2] as 'confirm' | 'repair', body);
    const match = /^\/api\/projects\/([a-z0-9-]{1,40})(?:\/(checkpoint|wrap|update|restore))?$/.exec(route);
    if (!match) return reply(404, { error: 'Project route not found.', code: 'not_found' });
    const project = match[1]!;
    if (method === 'GET' && !match[2]) {
      return reply(200, await session.withVault(vault => {
        const view = getProjectView(vault, project, undefined, { history: true });
        return { ...view, ...milestoneFields(view), cleared_revisions: clearedRevisions(vault, project) };
      }));
    }
    if (method === 'DELETE' && !match[2]) {
      // Owner request 2026-09-13: delete a project from the app. Forgets every
      // entry in the project scope (tombstones, chain intact) in one transaction.
      // ADR 0063 recheck R-S2: a shared project is deleted from Cloud Connect
      // first and unmarked in the same save, so a cloud copy cannot come back
      // without a prompt. A failed server delete deletes nothing.
      const scope = projectScope(project);
      const shared = await session.withVault(vault => vault.sharedScopes().includes(scope));
      const connector = loadConnectorConfig();
      if (shared && connector) {
        try {
          await unshareScope({ server: connector.server, deviceSecret: loadDeviceSecret(), scope });
        } catch {
          return reply(502, { error: `Could not delete project ${project} from Cloud Connect, so nothing was deleted. Try again.`, code: 'unshare_failed' });
        }
      }
      return reply(200, await session.withVault(vault => {
        const forgotten = vault.deleteProject(project);
        if (vault.sharedScopes().includes(scope)) vault.setScopeShared(scope, false);
        vault.save();
        return { project, forgotten, unshared: shared };
      }));
    }
    if (method === 'POST' && match[2] === 'restore') {
      // ADR 0063 D4: write an earlier version's exact text back as the new head,
      // bound to the head the caller was shown.
      if (body.length > 4 * 1024) return reply(400, { error: 'Restore request is too large.', code: 'invalid_request' });
      let input: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        input = parsed as Record<string, unknown>;
      } catch { return reply(400, { error: 'A JSON object is required.', code: 'invalid_request' }); }
      if (Object.keys(input).some(key => !['revision', 'expected_revision'].includes(key))) return reply(400, { error: 'Unexpected restore field.', code: 'invalid_request' });
      if (typeof input.revision !== 'string' || typeof input.expected_revision !== 'string') return reply(400, { error: 'revision and expected_revision are required.', code: 'invalid_request' });
      const request = { project, revision: input.revision, expected_revision: input.expected_revision, writer: appWriter(session) };
      return reply(200, await session.withVault(vault => {
        const current = vault.restoreProjectRevision(request);
        vault.save();
        return current;
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
        const current = vault.updateProject(request, { actor: 'owner' });
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
      const result = vault.checkpointProject(request, { actor: 'owner' });
      if (!result.replayed) vault.save();
      return result;
    }));
  } catch (error) {
    if (error instanceof ProjectHandoffError) {
      const status = error.code === 'invalid_request' ? 400 : error.code === 'not_found' ? 404 : error.code === 'scope_denied' ? 403 : 409;
      return reply(status, { error: error.message, code: error.code, ...(error.current ? { current: error.current } : {}) });
    }
    if (error instanceof MilestoneError) return reply(409, { error: error.message, code: 'milestone_refused' });
    if (error instanceof Error && error.name === 'LockedError') return reply(423, { error: 'Vault is locked.', code: 'locked' });
    return reply(500, { error: 'The save could not be confirmed. Retry the same update to check its result.', code: 'save_uncertain' });
  }
}
