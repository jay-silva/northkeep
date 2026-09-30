import {
  ProjectHandoffError,
  getProjectView,
  isMemoryType,
  parseProjectSlug,
  projectScope,
  type MemoryType,
  type Vault,
} from '@northkeep/core';
import { deriveConnectorToken } from './creds.js';
import { assertConnectorUrl } from './connector-config.js';
import { timeoutSignal } from './abort.js';

/**
 * The hosted-connector client (ADR 0019, phase C2). Pushes the user's REAL vault
 * entries for the scopes they marked Shared to the connector server, so their
 * cloud AI apps can read them. Authenticates with the SAME connector token used
 * for /pair/start (Bearer; the server keys accounts on its sha256).
 *
 * Transport conventions mirror the sync client: `redirect:'error'` (a redirect
 * could re-send the token/content to an attacker's Location), `AbortSignal.
 * timeout`, and status-only error messages (never echo a response body).
 */

const TIMEOUT_MS = 30_000;

/**
 * What every surface says when an unshare did not reach the server (ADR 0061).
 * The scope stays marked Shared because the server still holds its copies.
 */
export const UNSHARE_FAILED_MESSAGE =
  'Could not delete this scope from the connector server, so it is still marked Shared. ' +
  'Try again. If it keeps failing, contact support and we will delete it.';

/**
 * The server delete succeeded but this device could not record the unshare
 * (ADR 0061 code review note 2). Unsharing again finishes it and deletes
 * nothing more on the server.
 */
export const UNSHARE_LOCAL_SAVE_FAILED_MESSAGE =
  'The connector server deleted this scope, but this device could not save that it is now private, ' +
  'so it still shows as Shared here. Unshare it again to finish; nothing more will be deleted.';

/** Added to every connector 402: unshare never needs a subscription (ADR 0061). */
export const LAPSED_UNSHARE_HINT = 'You can still unshare scopes, which deletes them from the connector.';

/** Status-only error for a refused connector call; a 402 carries the unshare hint. */
function httpError(status: number, op: string): Error {
  const base = `Connector server returned HTTP ${status} on ${op}.`;
  return new Error(status === 402 ? `${base} ${LAPSED_UNSHARE_HINT}` : base);
}


/** Entry as pushed on the wire — byte-faithful to the vault (id/hash/scope/type/content). */
export interface PushEntry {
  entry_id: string;
  entry_hash: string;
  scope: string;
  type: string;
  content: string;
}

export interface ManifestEntry {
  entry_id: string;
  entry_hash: string;
  scope: string;
}

export interface PushSharedResult {
  /** How many entries were sent (the server made these scopes match exactly). */
  pushed: number;
  /** The scopes reconciled. */
  scopes: string[];
}

function authHeaders(deviceSecret: Buffer, entitlement?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${deriveConnectorToken(deviceSecret)}` };
  // The billing gate (ADR 0019 C3): the desktop forwards the anonymous
  // "active subscriber" attestation it fetched from the sync server. Absent on a
  // self-hosted / ungated connector — the header is optional.
  if (entitlement) headers['x-nb-entitlement'] = entitlement;
  return headers;
}

/**
 * Fetch an anonymous entitlement attestation from the SYNC server (authenticated
 * with the sync token), to forward to the connector's billing gate. Returns null
 * if the sync server has no entitlement bridge configured (404) — the connector
 * is then either ungated or gates by its own allowlist.
 */
export async function fetchEntitlement(opts: { syncServer: string; syncToken: string }): Promise<string | null> {
  const server = opts.syncServer.replace(/\/$/, '');
  const res = await fetch(`${server}/api/entitlement`, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.syncToken}`, 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: timeoutSignal(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on entitlement.`);
  const body = (await res.json()) as { entitlement?: string };
  return body.entitlement ?? null;
}

function normalizeServer(server: string): string {
  return assertConnectorUrl(server).toString().replace(/\/$/, '');
}

/**
 * ADR 0020: HTTP 409 `reencrypt_required` means the server holds rows or key
 * wraps it cannot open for this account (e.g. state restored across a key
 * wipe). The vault is the source of truth: a re-push wipes and re-creates the
 * shared scopes' rows under a fresh key chain. Status-only — never echoes the
 * response body.
 */
function reencryptError(): Error {
  return new Error(
    'The connector server cannot decrypt this account\'s shared data (409). ' +
      'Re-push your shared scopes (e.g. `northkeep share push`) to re-encrypt them from the vault, then retry.',
  );
}

/**
 * HTTP 412: a pushed scope has a connector tombstone the client did not
 * outrank. Distinct from ADR 0020's 409 reencrypt_required. Clients must
 * not treat this as "re-push".
 *
 * PUT /client/entries body (0.20.0):
 *   { scopes: string[], entries: PushEntry[], shared_at?: Record<string, string> }
 * shared_at maps scope → vault shared_at (ISO-8601). Omitted on 0.19.0 clients.
 */
export class ConnectorTombstoneError extends Error {
  readonly scopes: string[];
  constructor(scopes: string[] = []) {
    const named = scopes.length > 0 ? ` Conflicting scopes: ${scopes.join(', ')}.` : '';
    super(`This scope was unshared. Re-share it deliberately if you want it back.${named}`);
    this.name = 'ConnectorTombstoneError';
    this.scopes = scopes;
  }
}

/**
 * ADR 0063 D5: which vault-sync copy a push was taken from. `server` is the
 * first 16 hex of sha256 of the sync server URL; `version` is the sync-server
 * version this device holds exactly.
 */
export interface VaultStamp {
  server: string;
  version: number;
}

/** What every surface says when the connector refuses an older push (HTTP 428 `stale_push`). */
export const STALE_PUSH_MESSAGE =
  'Another device pushed a newer copy to Cloud Connect. Sync this Mac first. ' +
  'If this Mac is already in sync (for example after your sync server was reset), run: northkeep share push --reset-order';

/** HTTP 428: the connector already accepted a push from a newer vault version (D5). */
export class ConnectorStalePushError extends Error {
  readonly vaultVersion: number | null;
  constructor(vaultVersion: number | null) {
    super(STALE_PUSH_MESSAGE);
    this.name = 'ConnectorStalePushError';
    this.vaultVersion = vaultVersion;
  }
}

/**
 * "Make these scopes match": read the live (non-forgotten, non-superseded)
 * entries in each shared scope from the OPEN vault and PUT them so the server's
 * rows for those scopes become EXACTLY these. A vault entry the user forgot or
 * removed disappears server-side on the next push.
 *
 * `scopes` MUST be the user's configured shared-scope list, not the scopes that
 * happen to have entries — a scope emptied of its last memory must still be sent
 * so the server clears its now-stale rows.
 */
export async function pushSharedScopes(opts: {
  server: string;
  deviceSecret: Buffer;
  scopes: string[];
  /** An open vault, or a snapshot of one taken under the vault lock (ADR 0063 D5). */
  vault: Pick<Vault, 'list' | 'sharedScopeRows'>;
  /** Optional entitlement attestation forwarded to the connector's billing gate. */
  entitlement?: string;
  /** ADR 0063 D5: the vault-sync copy this push was taken from. Absent on a device with no vault sync. */
  vaultStamp?: VaultStamp;
  /** ADR 0063 D5: replace the connector's recorded vault order (`share push --reset-order`, manual only). */
  reset?: boolean;
}): Promise<PushSharedResult> {
  const server = normalizeServer(opts.server);
  const scopes = [...new Set(opts.scopes)];
  const entries: PushEntry[] = [];
  for (const scope of scopes) {
    // list() excludes forgotten + superseded by default → live entries only.
    for (const e of opts.vault.list({ scope })) {
      entries.push({
        entry_id: e.id,
        entry_hash: e.entry_hash,
        scope: e.scope,
        type: e.type,
        content: e.content,
      });
    }
  }
  const shared_at: Record<string, string> = {};
  for (const row of opts.vault.sharedScopeRows()) {
    if (scopes.includes(row.scope) && row.shared_at) shared_at[row.scope] = row.shared_at;
  }
  const res = await fetch(`${server}/client/entries`, {
    method: 'PUT',
    headers: { ...authHeaders(opts.deviceSecret, opts.entitlement), 'content-type': 'application/json' },
    body: JSON.stringify({
      scopes,
      entries,
      shared_at,
      ...(opts.vaultStamp ? { vault: opts.vaultStamp } : {}),
      ...(opts.reset === true ? { reset: true } : {}),
    }),
    redirect: 'error',
    signal: timeoutSignal(TIMEOUT_MS),
  });
  // First, so a stale push is never read as the 409 re-encrypt or 412 tombstone error.
  if (res.status === 428) {
    const body = (await res.json().catch(() => ({}))) as { vault_version?: unknown };
    throw new ConnectorStalePushError(typeof body.vault_version === 'number' ? body.vault_version : null);
  }
  if (res.status === 413) {
    throw new Error(
      'The connector server rejected the push: over the sharing caps (too many shared memories, or a memory is too large).',
    );
  }
  if (res.status === 401) throw new Error('The connector server rejected the connector token (401).');
  if (res.status === 409) throw reencryptError();
  if (res.status === 412) {
    const body = (await res.json().catch(() => ({}))) as { scopes?: unknown };
    const named = Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === 'string')
      : [];
    throw new ConnectorTombstoneError(named);
  }
  if (!res.ok) throw httpError(res.status, 'push');
  return { pushed: entries.length, scopes };
}

/** Unshare a scope: DELETE all its rows server-side and record a tombstone. */
export async function unshareScope(opts: {
  server: string;
  deviceSecret: Buffer;
  scope: string;
}): Promise<{ deleted: number }> {
  const server = normalizeServer(opts.server);
  const res = await fetch(`${server}/client/scope/${encodeURIComponent(opts.scope)}`, {
    method: 'DELETE',
    headers: authHeaders(opts.deviceSecret),
    redirect: 'error',
    signal: timeoutSignal(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Connector server returned HTTP ${res.status} on unshare.`);
  const body = (await res.json().catch(() => ({}))) as { deleted?: number };
  return { deleted: body.deleted ?? 0 };
}

/** The server's current shared-scope manifest for this account (for diffing/status). */
export async function getManifest(opts: { server: string; deviceSecret: Buffer }): Promise<ManifestEntry[]> {
  return (await getConnectorManifest(opts)).entries;
}

/**
 * The manifest plus whether the connector refuses pushes to unshared scopes
 * (ADR 0063 D5). An absent flag reads as off: automatic push must not assume
 * a protection the server did not say it has.
 */
export async function getConnectorManifest(opts: {
  server: string;
  deviceSecret: Buffer;
  entitlement?: string;
}): Promise<{ entries: ManifestEntry[]; tombstone_enforce: boolean }> {
  const server = normalizeServer(opts.server);
  const res = await fetch(`${server}/client/manifest`, {
    headers: authHeaders(opts.deviceSecret, opts.entitlement),
    redirect: 'error',
    signal: timeoutSignal(TIMEOUT_MS),
  });
  if (!res.ok) throw httpError(res.status, 'manifest');
  const body = (await res.json()) as { entries?: ManifestEntry[]; tombstone_enforce?: unknown };
  return { entries: body.entries ?? [], tombstone_enforce: body.tombstone_enforce === true };
}

/** A pending row's recorded base for a connector-born project document (ADR 0063, section 2). */
export const BASE_NEW = 'new';

/** One connector-born row awaiting down-sync, as `/client/pending?v=2` delivers it. */
export interface PendingRow {
  server_id: string;
  scope: string;
  type: string;
  content: string;
  /** A vault entry id, the literal `new`, or null for a legacy row written with no base. */
  base_revision: string | null;
  /** True when the connector no longer serves this row as the head (D2). */
  stale: boolean;
}

export interface PendingSnapshot {
  entries: PendingRow[];
  /** Entry ids a connected app asked to forget. */
  forgets: string[];
}

export type ConflictReason = 'moved' | 'stale' | 'legacy' | 'several_heads';

/** A cloud project document that was not applied because it is not a fast-forward (D1). */
export interface DownSyncConflict {
  scope: string;
  project: string;
  server_id: string;
  base_revision: string | null;
  /** The local head it was checked against; null when there is none or there are several. */
  local_revision: string | null;
  reason: ConflictReason;
  /** The cloud text, for "view both" and "keep mine". */
  content: string;
}

export interface PlannedAddition {
  server_id: string;
  scope: string;
  type: MemoryType;
  content: string;
  /** `project` creates a project document from a base-`new` row. */
  kind: 'memory' | 'project';
}

/** A fast-forward: the cloud document replaces the local head it was written against. */
export interface PlannedReplacement {
  server_id: string;
  scope: string;
  project: string;
  content: string;
  local_revision: string;
}

export interface PlannedForget {
  entry_id: string;
  scope: string;
  first_line: string;
}

/**
 * What a down-sync would do, computed without writing anything (D3). Additions,
 * dedupes and discards need no confirmation; replacements and forgets do.
 */
export interface DownSyncPlan {
  additions: PlannedAddition[];
  replacements: PlannedReplacement[];
  forgets: PlannedForget[];
  /** Rows whose text is already the live entry: acked against it, no vault write. */
  dedupes: Array<{ server_id: string; local_entry_id: string }>;
  /** Stale or legacy rows whose text is already the local head: deleted by id, no vault write. */
  discards: Array<{ server_id: string; scope: string }>;
  /** Forgets for entries not live here: acked, nothing to change. */
  settled_forgets: string[];
  conflicts: DownSyncConflict[];
  /** Rows left pending because their unshared project scope is not accepting them (ADR 0050). */
  held: number;
  held_scopes: string[];
  /** Phone only: replacements, forgets and dedupes left for a device with a preview screen. */
  deferred: number;
  /** Rows dropped unapplied and unacked because their type is not a memory type. */
  skipped: number;
  /** Scopes the ADR 0050 fold marks Shared when its rows are applied. */
  to_mark: string[];
}

/** A plan with a replacement or a forget must be confirmed before it is applied (D3). */
export function planNeedsConfirmation(plan: Pick<DownSyncPlan, 'replacements' | 'forgets'>): boolean {
  return plan.replacements.length > 0 || plan.forgets.length > 0;
}

export interface DownSyncResult {
  /** New vault entries created from connector-born rows (memories and new projects). */
  added: number;
  /** Project documents replaced by an approved fast-forward. */
  replaced: number;
  /** Vault entries tombstoned by an approved forget. */
  forgotten: number;
  /** Rows acked against an identical live entry. */
  deduped: number;
  /** Stale or legacy rows deleted because their text was already the local head. */
  discarded: number;
  held: number;
  held_scopes: string[];
  skipped: number;
  deferred: number;
  conflicts: DownSyncConflict[];
  /** Replacements and forgets that were not approved; they stay pending. */
  needs_review: { replacements: PlannedReplacement[]; forgets: PlannedForget[] };
}

/**
 * What every sync surface tells the user about a held scope (ADR 0050
 * Decision 4). The second sentence is the one the fifth review required: the
 * user is choosing to let the app's document win.
 */
export function holdMessage(slug: string): string {
  return (
    `A connected app wrote to project ${slug}, which is private on this device. ` +
    `Share project:${slug} in NorthKeep to accept it. ` +
    "Sharing it lets the app's document replace the one on this device; the current one stays in history."
  );
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Fetch the pending rows (ADR 0063 `?v=2`). Side effects on the server are idempotent and touch no vault. */
export async function fetchPending(opts: { server: string; deviceSecret: Buffer; entitlement?: string }): Promise<PendingSnapshot> {
  const server = normalizeServer(opts.server);
  const res = await fetch(`${server}/client/pending?v=2`, {
    headers: authHeaders(opts.deviceSecret, opts.entitlement),
    redirect: 'error',
    signal: timeoutSignal(TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error('The connector server rejected the connector token (401).');
  if (res.status === 402) {
    throw new Error(`The connector server requires an active subscription (402) to down-sync. ${LAPSED_UNSHARE_HINT}`);
  }
  if (res.status === 409) throw reencryptError();
  if (!res.ok) throw httpError(res.status, 'pending');
  const body = (await res.json()) as { entries?: unknown; forgets?: unknown };
  const entries: PendingRow[] = [];
  for (const raw of Array.isArray(body.entries) ? body.entries : []) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const server_id = asString(r.server_id);
    const content = asString(r.content);
    // vault.remember trims the scope, so a padded name would take the
    // non-project path and land inside a private project.
    const scope = asString(r.scope)?.trim() ?? '';
    if (!server_id || !content || !scope) continue;
    // Anything but a non-empty string is a legacy row: no base is ever inferred.
    const base = asString(r.base_revision);
    entries.push({ server_id, scope, type: asString(r.type) ?? '', content, base_revision: base === '' ? null : base, stale: r.stale === true });
  }
  const forgets: string[] = [];
  for (const f of Array.isArray(body.forgets) ? body.forgets : []) {
    const id = f && typeof f === 'object' ? asString((f as Record<string, unknown>).entry_id) : null;
    if (id) forgets.push(id);
  }
  return { entries, forgets };
}

type LocalHead = { kind: 'none' } | { kind: 'one'; id: string; content: string } | { kind: 'several' };

function localHead(vault: Vault, project: string): LocalHead {
  try {
    const view = getProjectView(vault, project);
    return { kind: 'one', id: view.revision, content: view.content };
  } catch (err) {
    if (err instanceof ProjectHandoffError && err.code === 'not_found') return { kind: 'none' };
    // project_conflict, or a head the reader cannot parse: never apply over it.
    return { kind: 'several' };
  }
}

/**
 * D1: classify every pending row against the local vault without writing
 * anything. Rows are re-derived from the server each time, so the plan is
 * idempotent across crashes and devices.
 */
export function planDownSync(opts: { vault: Vault; pending: PendingSnapshot; additiveOnly?: boolean }): DownSyncPlan {
  const { vault, pending } = opts;
  const additiveOnly = opts.additiveOnly === true;
  const plan: DownSyncPlan = {
    additions: [],
    replacements: [],
    forgets: [],
    dedupes: [],
    discards: [],
    settled_forgets: [],
    conflicts: [],
    held: 0,
    held_scopes: [],
    deferred: 0,
    skipped: 0,
    to_mark: [],
  };
  const groups = new Map<string, PendingRow[]>();
  for (const row of pending.entries) {
    const group = groups.get(row.scope);
    if (group) group.push(row);
    else groups.set(row.scope, [row]);
  }
  const sharedHere = new Set(vault.sharedScopes());
  const heldScopes = new Set<string>();
  const applicable: PendingRow[] = [];

  // ADR 0050 Decision 4: an unshared project scope is classified before any
  // dedupe or apply, so the fold is the only path into it.
  for (const [scope, group] of groups) {
    if (parseProjectSlug(scope) === null || sharedHere.has(scope)) {
      for (const row of group) {
        if (!isMemoryType(row.type)) plan.skipped++;
        else applicable.push(row);
      }
      continue;
    }
    const empty = vault.list({ scope }).length === 0;
    const working = group.filter((r) => r.type === 'working');
    const foldable = group.every((r) => isMemoryType(r.type)) && empty && working.length === 1
      && working[0]!.base_revision === BASE_NEW && !working[0]!.stale;
    if (foldable) {
      applicable.push(...group);
      plan.to_mark.push(scope);
      continue;
    }
    plan.held += group.length;
    heldScopes.add(scope);
  }

  const heads = new Map<string, LocalHead>();
  for (const row of applicable) {
    const project = parseProjectSlug(row.scope);
    if (project === null || row.type !== 'working') {
      const dup = vault.list({ scope: row.scope }).find((v) => v.content === row.content);
      if (dup) plan.dedupes.push({ server_id: row.server_id, local_entry_id: dup.id });
      else plan.additions.push({ server_id: row.server_id, scope: row.scope, type: row.type as MemoryType, content: row.content, kind: 'memory' });
      continue;
    }
    let head = heads.get(project);
    if (head === undefined) {
      head = localHead(vault, project);
      heads.set(project, head);
    }
    const legacy = row.base_revision === null;
    const conflict = (reason: ConflictReason) =>
      plan.conflicts.push({
        scope: row.scope,
        project,
        server_id: row.server_id,
        base_revision: row.base_revision,
        local_revision: head.kind === 'one' ? head.id : null,
        reason,
        content: row.content,
      });
    if (head.kind === 'one' && row.content === head.content) {
      if (additiveOnly) {
        plan.deferred++;
      } else if (!row.stale && !legacy) {
        plan.dedupes.push({ server_id: row.server_id, local_entry_id: head.id });
      } else {
        // An ack would rename the row to a head that may be behind the
        // connector's and move its head backward (D1), so delete it by id.
        plan.discards.push({ server_id: row.server_id, scope: row.scope });
      }
      continue;
    }
    // Every legacy row is also stale on the connector; legacy is the more useful label.
    if (legacy) {
      conflict('legacy');
      continue;
    }
    if (row.stale) {
      conflict('stale');
      continue;
    }
    if (head.kind === 'several') {
      conflict('several_heads');
      continue;
    }
    if (head.kind === 'one' && row.base_revision === head.id) {
      if (additiveOnly) plan.deferred++;
      else plan.replacements.push({ server_id: row.server_id, scope: row.scope, project, content: row.content, local_revision: head.id });
      continue;
    }
    if (head.kind === 'none' && row.base_revision === BASE_NEW) {
      plan.additions.push({ server_id: row.server_id, scope: row.scope, type: 'working', content: row.content, kind: 'project' });
      continue;
    }
    conflict('moved');
  }

  const live = new Map(vault.list().map((e) => [e.id, e]));
  for (const id of pending.forgets) {
    const entry = live.get(id);
    if (entry === undefined) {
      // Nothing to change here. The phone never acks a forget, so the Mac still sees it.
      if (additiveOnly) plan.deferred++;
      else plan.settled_forgets.push(id);
    } else if (additiveOnly) {
      plan.deferred++;
    } else {
      plan.forgets.push({ entry_id: id, scope: entry.scope, first_line: firstLine(entry.content) });
    }
  }
  plan.held_scopes = [...heldScopes].sort();
  return plan;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

async function postJson(opts: { server: string; deviceSecret: Buffer; entitlement?: string }, route: string, body: unknown, op: string): Promise<void> {
  const res = await fetch(`${normalizeServer(opts.server)}${route}`, {
    method: 'POST',
    headers: { ...authHeaders(opts.deviceSecret, opts.entitlement), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: timeoutSignal(TIMEOUT_MS),
  });
  if (!res.ok) throw httpError(res.status, op);
}

/** Delete exactly these pending rows by id (ADR 0063 `/client/discard`). */
export async function discardPending(opts: { server: string; deviceSecret: Buffer; entitlement?: string; server_ids: string[] }): Promise<void> {
  if (opts.server_ids.length === 0) return;
  await postJson(opts, '/client/discard', { server_ids: opts.server_ids }, 'discard');
}

/**
 * D3 apply: fetch the pending rows again, re-plan, and apply the additions
 * plus only the replacements (by server_id) and forgets (by entry_id) the user
 * approved. Anything new since the preview stays pending. Saves before any
 * ack or discard, so a failure after the save is retried as a no-op. The
 * caller pushes afterwards.
 */
export async function applyDownSync(opts: {
  server: string;
  deviceSecret: Buffer;
  vault: Vault;
  entitlement?: string;
  approve?: { server_ids?: string[]; forget_ids?: string[] };
  /** The phone (ADR 0063 D1): additions only, never a replace, a forget or a forget ack. */
  additiveOnly?: boolean;
}): Promise<DownSyncResult> {
  const clientLabel = new URL(normalizeServer(opts.server)).hostname;
  const pending = await fetchPending(opts);
  const plan = planDownSync({ vault: opts.vault, pending, additiveOnly: opts.additiveOnly === true });
  const approvedRows = new Set(opts.additiveOnly ? [] : (opts.approve?.server_ids ?? []));
  const approvedForgets = new Set(opts.additiveOnly ? [] : (opts.approve?.forget_ids ?? []));
  const acked: Array<{ server_id: string; local_entry_id: string }> = [...plan.dedupes];
  const conflicts = [...plan.conflicts];
  let wrote = false;
  let added = 0;
  let replaced = 0;
  let forgotten = 0;

  for (const a of plan.additions) {
    const metadata = { connector: { server_id: a.server_id } };
    if (a.kind === 'project') {
      const project = parseProjectSlug(a.scope)!;
      try {
        const view = opts.vault.replaceProjectContent({ project, expected_revision: null, content: a.content, source: `connector:${clientLabel}`, metadata });
        acked.push({ server_id: a.server_id, local_entry_id: view.revision });
        added++;
        wrote = true;
      } catch (err) {
        if (!(err instanceof ProjectHandoffError)) throw err;
        conflicts.push({ scope: a.scope, project, server_id: a.server_id, base_revision: BASE_NEW, local_revision: null, reason: 'moved', content: a.content });
      }
      continue;
    }
    const created = opts.vault.remember({ content: a.content, type: a.type, scope: a.scope, source: `connector:${clientLabel}`, metadata });
    acked.push({ server_id: a.server_id, local_entry_id: created.id });
    added++;
    wrote = true;
  }

  const unapprovedReplacements: PlannedReplacement[] = [];
  for (const r of plan.replacements) {
    if (!approvedRows.has(r.server_id)) {
      unapprovedReplacements.push(r);
      continue;
    }
    try {
      const view = opts.vault.replaceProjectContent({
        project: r.project,
        expected_revision: r.local_revision,
        content: r.content,
        source: `connector:${clientLabel}`,
        metadata: { connector: { server_id: r.server_id } },
      });
      acked.push({ server_id: r.server_id, local_entry_id: view.revision });
      replaced++;
      wrote = true;
    } catch (err) {
      if (!(err instanceof ProjectHandoffError)) throw err;
      // A local save landed between the plan and the write: hold, never overwrite.
      conflicts.push({ scope: r.scope, project: r.project, server_id: r.server_id, base_revision: r.local_revision, local_revision: null, reason: 'moved', content: r.content });
    }
  }

  // The mark rides the same save that precedes the ack. Marking after the ack
  // would leave a crash window whose residual never heals (ADR 0050).
  for (const scope of plan.to_mark) {
    opts.vault.setScopeShared(scope, true);
    wrote = true;
  }

  const ackedForgets = [...plan.settled_forgets];
  const unapprovedForgets: PlannedForget[] = [];
  for (const f of plan.forgets) {
    if (!approvedForgets.has(f.entry_id)) {
      unapprovedForgets.push(f);
      continue;
    }
    opts.vault.forget(f.entry_id);
    ackedForgets.push(f.entry_id);
    forgotten++;
    wrote = true;
  }

  if (wrote) opts.vault.save();
  await discardPending({ ...opts, server_ids: plan.discards.map((d) => d.server_id) });
  if (acked.length > 0 || ackedForgets.length > 0) {
    await postJson(opts, '/client/ack', { acked, forgets: ackedForgets }, 'ack');
  }

  return {
    added,
    replaced,
    forgotten,
    deduped: plan.dedupes.length,
    discarded: plan.discards.length,
    held: plan.held,
    held_scopes: plan.held_scopes,
    skipped: plan.skipped,
    deferred: plan.deferred,
    conflicts,
    needs_review: { replacements: unapprovedReplacements, forgets: unapprovedForgets },
  };
}

/** The first line of the memory "keep mine" saves (founder decision, 2026-09-30). */
export function keptCloudVersionTitle(now: Date): string {
  return `Cloud version not kept, ${now.toISOString().slice(0, 10)}`;
}

export type ConflictChoice = 'take-theirs' | 'keep-mine';

export interface ResolveResult {
  choice: ConflictChoice;
  /** The rows resolved. */
  server_ids: string[];
  /** Take theirs: the new local head. */
  revision: string | null;
  /** Keep mine: the memories holding the cloud text. */
  memory_ids: string[];
}

/**
 * Resolve the conflicts D1 held for one project. Take theirs writes the cloud
 * text over the head the user was shown (refusing if it moved), saves, acks.
 * Keep mine saves the cloud text as an episodic memory first, saves, then
 * deletes the rows by id; a retry finds the memory by its metadata. The caller
 * pushes afterwards.
 */
export async function resolveConflict(opts: {
  server: string;
  deviceSecret: Buffer;
  vault: Vault;
  entitlement?: string;
  project: string;
  choice: ConflictChoice;
  /** One row, when several cloud versions wait for this project. */
  server_id?: string;
  /** The local head the user was shown. Defaults to the current head. */
  expected_revision?: string | null;
  now?: Date;
}): Promise<ResolveResult> {
  const scope = projectScope(opts.project);
  const clientLabel = new URL(normalizeServer(opts.server)).hostname;
  const plan = planDownSync({ vault: opts.vault, pending: await fetchPending(opts) });
  const waiting = plan.conflicts.filter((c) => c.scope === scope && (opts.server_id === undefined || c.server_id === opts.server_id));
  if (waiting.length === 0) throw new Error(`No cloud version is waiting for project ${opts.project}.`);

  if (opts.choice === 'take-theirs') {
    if (waiting.length > 1) {
      throw new Error(`${waiting.length} cloud versions are waiting for project ${opts.project}. Pick one by its id.`);
    }
    const row = waiting[0]!;
    if (row.reason === 'several_heads') {
      throw new Error(`Project ${opts.project} has more than one current document on this device. Fix that first, then try again.`);
    }
    const head = localHead(opts.vault, opts.project);
    const expected = opts.expected_revision !== undefined ? opts.expected_revision : head.kind === 'one' ? head.id : null;
    const view = opts.vault.replaceProjectContent({
      project: opts.project,
      expected_revision: expected,
      content: row.content,
      source: `connector:${clientLabel}`,
      metadata: { connector: { server_id: row.server_id } },
    });
    opts.vault.save();
    await postJson(opts, '/client/ack', { acked: [{ server_id: row.server_id, local_entry_id: view.revision }], forgets: [] }, 'ack');
    return { choice: 'take-theirs', server_ids: [row.server_id], revision: view.revision, memory_ids: [] };
  }

  const now = opts.now ?? new Date();
  const existing = new Map<string, string>();
  for (const e of opts.vault.list({ scope })) {
    const discarded = (e.metadata?.connector as { discarded?: unknown } | undefined)?.discarded;
    if (typeof discarded === 'string') existing.set(discarded, e.id);
  }
  const memoryIds: string[] = [];
  let wrote = false;
  for (const row of waiting) {
    const kept = existing.get(row.server_id);
    if (kept !== undefined) {
      memoryIds.push(kept);
      continue;
    }
    // Non-working on purpose: a second working entry would make the project unreadable.
    const memory = opts.vault.remember({
      content: `# ${keptCloudVersionTitle(now)}\n\n${row.content}`,
      type: 'episodic',
      scope,
      source: `connector:${clientLabel}`,
      metadata: { connector: { discarded: row.server_id } },
    });
    memoryIds.push(memory.id);
    wrote = true;
  }
  if (wrote) opts.vault.save();
  const serverIds = waiting.map((c) => c.server_id);
  await discardPending({ ...opts, server_ids: serverIds });
  return { choice: 'keep-mine', server_ids: serverIds, revision: null, memory_ids: memoryIds };
}

/**
 * POST /pair/start -> the 8-char single-use pairing code the user types into the
 * AI app's OAuth consent page. Bearer connector_token; the server binds the
 * eventual OAuth grant to this account.
 */
export async function startPairing(opts: {
  server: string;
  deviceSecret: Buffer;
  entitlement?: string;
}): Promise<string> {
  const server = normalizeServer(opts.server);
  const res = await fetch(`${server}/pair/start`, {
    method: 'POST',
    headers: { ...authHeaders(opts.deviceSecret, opts.entitlement), 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: timeoutSignal(TIMEOUT_MS),
  });
  if (res.status === 409) throw reencryptError();
  if (!res.ok) throw httpError(res.status, 'pairing');
  const body = (await res.json()) as { pairing_code?: string };
  if (!body.pairing_code) throw new Error('Connector server did not return a pairing code.');
  return body.pairing_code;
}
