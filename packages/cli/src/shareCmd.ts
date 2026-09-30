import { loadDeviceSecret, projectScope, type Vault } from '@northkeep/core';
import {
  applyDownSync,
  assertDeviceCanPush,
  connectorAutoPushEnabled,
  connectorPaired,
  deriveConnectorToken,
  deriveSyncCreds,
  fetchEntitlement,
  fetchPending,
  foldSidecarScopesIntoVault,
  holdMessage,
  loadConnectorConfig,
  loadSyncConfig,
  manualConnectorPush,
  markConnectorPaired,
  planDownSync,
  planNeedsConfirmation,
  resolveConflict,
  setConnectorAutoPush,
  setConnectorServer,
  startPairing,
  tokenHash,
  unshareScope,
  UNSHARE_FAILED_MESSAGE,
  UNSHARE_LOCAL_SAVE_FAILED_MESSAGE,
  type ConflictReason,
  type ConnectorConfig,
  type DownSyncConflict,
  type DownSyncPlan,
  type PushSharedResult,
} from '@northkeep/sync';
import { promptLine } from './prompt.js';

/**
 * `northkeep share` — mark scopes Shared and push the REAL vault entries in those
 * scopes to the hosted connector (ADR 0019, phase C2). Private is the default;
 * sharing is per-scope, loudly confirmed, and reversible with server-side
 * deletion.
 *
 * The shared-scope list lives IN THE VAULT (ADR 0038), so a mark made here is a
 * mark on every device after the next vault sync. Each command folds a pre-0038
 * sidecar list into the vault first (idempotent), so nothing is silently
 * revoked by upgrading.
 *
 * Every push to the connector follows ADR 0063 D5: the vault goes to the sync
 * server first when this device is ahead, and a device that is behind or
 * diverged is refused before anything is written.
 */

export type WithVault = <T>(fn: (vault: Vault) => Promise<T> | T) => Promise<T>;

/** What a share command needs from the CLI (index.ts), injected so tests use a cheap-KDF vault. */
export interface ShareDeps {
  withVault: WithVault;
  vaultPath: string;
  /** A copy of the master key, resolved at most once. Called only when vault sync is configured. */
  masterKey: () => Promise<Buffer>;
  /** Asks one question; null when there is no terminal to ask on. */
  ask: (question: string) => Promise<string | null>;
}

function deviceSecretOrFail(fail: (m: string) => never): Buffer {
  try {
    return loadDeviceSecret();
  } catch {
    fail('No device secret found. Run "northkeep init" first.');
  }
}

function requireConfig(fail: (m: string) => never): ConnectorConfig {
  const cfg = loadConnectorConfig();
  if (!cfg) fail('No connector server configured. Run: northkeep share server <url>');
  return cfg;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort entitlement attestation for the connector's billing gate: if a
 * sync server is configured, fetch an anonymous "active subscriber" token to
 * forward. Never blocks sharing — a self-hosted / ungated connector needs none,
 * and a truly gated one returns a clear 402 that surfaces on the actual request.
 */
async function maybeEntitlement(deviceSecret: Buffer): Promise<string | undefined> {
  const sync = loadSyncConfig();
  if (!sync) return undefined;
  try {
    const { token } = deriveSyncCreds(deviceSecret);
    return (await fetchEntitlement({ syncServer: sync.serverUrl, syncToken: token })) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The D5 manual push, with the key asked for only when vault sync needs it. */
async function pushNow(
  cfg: ConnectorConfig,
  deviceSecret: Buffer,
  entitlement: string | undefined,
  deps: ShareDeps,
  reset = false,
): Promise<PushSharedResult | null> {
  const masterKey = loadSyncConfig() === null ? Buffer.alloc(0) : await deps.masterKey();
  try {
    return await manualConnectorPush({
      server: cfg.server,
      deviceSecret,
      vaultPath: deps.vaultPath,
      masterKey,
      withVault: deps.withVault,
      ...(entitlement ? { entitlement } : {}),
      ...(reset ? { reset: true } : {}),
    });
  } finally {
    masterKey.fill(0);
  }
}

export function shareServerCmd(url: string, fail: (m: string) => never): void {
  let cfg;
  try {
    cfg = setConnectorServer(url);
  } catch (err) {
    fail(message(err));
  }
  console.log(`✓ Connector server set: ${cfg.server}`);
  console.log('  Next: "northkeep share add <scope>" to share a scope, then "northkeep share code" to connect an AI app.');
}

export async function shareAddCmd(
  scope: string,
  options: { yes?: boolean },
  deps: ShareDeps,
  fail: (m: string) => never,
): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);

  const assumeYes = options.yes === true || process.env.NORTHKEEP_ASSUME_YES === '1';
  if (!assumeYes) {
    console.log(
      `Memories in '${scope}' will be copied to NorthKeep's connector server, where the AI apps you connect read them IN FULL. ` +
        'They are stored encrypted at rest; the connector database holds no key that can read them, but the server rebuilds ' +
        "the key each request from your app's credential plus a secret it holds and briefly decrypts them to answer. It can " +
        "always see this scope's name, how many memories it holds, and when they change. Private scopes are never shared. " +
        'Sharing applies to this scope on EVERY device that syncs this vault, and so does unsharing.',
    );
    const answer = await promptLine('Continue? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) fail('Cancelled. Nothing was shared.');
  }

  try {
    await assertDeviceCanPush({ vaultPath: deps.vaultPath, deviceSecret });
  } catch (err) {
    fail(`Nothing was shared. ${message(err)}`);
  }
  const entitlement = await maybeEntitlement(deviceSecret);
  const wasShared = await deps.withVault((vault) => {
    foldSidecarScopesIntoVault(vault);
    const was = vault.sharedScopes().includes(scope);
    vault.setScopeShared(scope, true);
    vault.save();
    return was;
  });
  let result: PushSharedResult | null;
  try {
    result = await pushNow(cfg, deviceSecret, entitlement, deps);
  } catch (err) {
    // Same rollback rule as the GUI and the phone (review F5/F1): a scope the
    // server never accepted must not stay marked. But never unmark a scope
    // that was already shared before this call; its server rows are real.
    if (!wasShared) {
      await deps.withVault((vault) => {
        vault.setScopeShared(scope, false);
        vault.save();
      });
      fail(`Sharing failed. The mark was rolled back, nothing is shared: ${message(err)}`);
    }
    fail(`Push failed: '${scope}' stays Shared (it already was): ${message(err)}`);
  }
  console.log(
    `✓ Scope '${scope}' is now Shared. Pushed ${result?.pushed ?? 0} memories across ${result?.scopes.length ?? 0} shared scope(s).`,
  );
  console.log('  Connect an AI app: northkeep share code');
}

export async function sharePushCmd(options: { resetOrder?: boolean }, deps: ShareDeps, fail: (m: string) => never): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  const entitlement = await maybeEntitlement(deviceSecret);
  await deps.withVault((vault) => foldSidecarScopesIntoVault(vault)); // saves the vault itself when it folds
  let result: PushSharedResult | null;
  try {
    result = await pushNow(cfg, deviceSecret, entitlement, deps, options.resetOrder === true);
  } catch (err) {
    fail(message(err));
  }
  if (result === null) {
    console.log(NOTHING_SHARED);
    return;
  }
  console.log(`✓ Pushed ${result.pushed} memories across ${result.scopes.length} shared scope(s) to ${cfg.server}.`);
  if (options.resetOrder) console.log("  Cloud Connect now treats this device's copy as the newest.");
}

const NOTHING_SHARED = 'No scopes are shared yet. Run: northkeep share add <scope>';

/** The slug holdMessage wants, from the scope the fold reports. */
function heldSlug(scope: string): string {
  return scope.startsWith('project:') ? scope.slice('project:'.length) : scope;
}

const REASONS: Record<ConflictReason, string> = {
  moved: 'this Mac changed it after the cloud version was written',
  stale: 'Cloud Connect already has a newer copy than the one this cloud version started from',
  legacy: 'the cloud version does not say which copy it started from',
  several_heads: 'this project has more than one current document on this Mac',
};

function conflictLine(c: DownSyncConflict): string {
  return `${c.project}: ${REASONS[c.reason]} (id ${c.server_id})`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function byScope(items: Array<{ scope: string }>): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.scope, (counts.get(i.scope) ?? 0) + 1);
  return [...counts].map(([scope, n]) => `${scope}: ${n}`).join(', ');
}

/** D3: what a Sync now would do, in plain words, before it does it. */
export function describePlan(plan: DownSyncPlan): string[] {
  const lines: string[] = [];
  const memories = plan.additions.filter((a) => a.kind === 'memory');
  const projects = plan.additions.filter((a) => a.kind === 'project');
  if (memories.length > 0) lines.push(`  ${plural(memories.length, 'new memory', 'new memories')} from your apps (${byScope(memories)})`);
  for (const p of projects) lines.push(`  New project from an app: ${heldSlug(p.scope)}`);
  if (plan.replacements.length > 0) {
    lines.push(`  ${plural(plan.replacements.length, 'project', 'projects')} would be replaced by the cloud version (the current one stays in history): ${plan.replacements.map((r) => r.project).join(', ')}`);
  }
  if (plan.forgets.length > 0) {
    lines.push(`  ${plural(plan.forgets.length, 'memory', 'memories')} would be forgotten:`);
    for (const f of plan.forgets) lines.push(`    ${f.scope}: "${f.first_line}"`);
  }
  if (plan.conflicts.length > 0) {
    lines.push(`  ${plural(plan.conflicts.length, 'conflict', 'conflicts')}, not applied (see "northkeep share conflicts"):`);
    for (const c of plan.conflicts) lines.push(`    ${conflictLine(c)}`);
  }
  return lines;
}

/**
 * `northkeep share sync` (ADR 0063 D3): preview what the connected apps
 * changed, ask before any replacement or forget, apply exactly what was
 * shown, then push. Conflicts are never applied; they wait for
 * `northkeep share resolve`.
 *
 * ADR 0050 Decision 5: a project created in a connected app arrives only
 * through the fold, which marks its scope, so the push reads the shared list
 * after the apply.
 */
export async function shareSyncCmd(options: { yes?: boolean }, deps: ShareDeps, fail: (m: string) => never): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  const assumeYes = options.yes === true || process.env.NORTHKEEP_ASSUME_YES === '1';
  const before = await deps.withVault((vault) => {
    foldSidecarScopesIntoVault(vault); // saves the vault itself when it folds
    return vault.sharedScopes();
  });
  // A device that never paired has no account there, and asking for pending
  // rows would create one (or 402). A pre-0.22 sidecar counts as paired.
  if (before.length === 0 && !connectorPaired()) {
    console.log(NOTHING_SHARED);
    return;
  }
  try {
    await assertDeviceCanPush({ vaultPath: deps.vaultPath, deviceSecret });
  } catch (err) {
    fail(`Nothing was changed. ${message(err)}`);
  }
  const entitlement = await maybeEntitlement(deviceSecret);
  const conn = { server: cfg.server, deviceSecret, ...(entitlement ? { entitlement } : {}) };
  const pending = await fetchPending(conn);
  const plan = await deps.withVault((vault) => planDownSync({ vault, pending }));
  const described = describePlan(plan);
  if (described.length > 0) {
    console.log('Changes from your connected apps:');
    for (const line of described) console.log(line);
  }
  if (planNeedsConfirmation(plan) && !assumeYes) {
    const answer = await deps.ask('Apply the replacements and forgets listed above? [y/N] ');
    if (answer === null) fail('These changes need your confirmation and there is no terminal to ask on. Nothing was changed. Run again with --yes to apply them.');
    if (!/^y(es)?$/i.test(answer.trim())) fail('Cancelled. Nothing was changed.');
  }
  const approve = { server_ids: plan.replacements.map((r) => r.server_id), forget_ids: plan.forgets.map((f) => f.entry_id) };
  const down = await deps.withVault((vault) => applyDownSync({ ...conn, vault, approve }));
  console.log(
    `✓ Down-synced: ${down.added} added, ${down.replaced} replaced, ${down.forgotten} forgotten, ${down.deduped} already present, ${down.held} held, ${down.skipped} skipped.`,
  );
  if (down.skipped > 0) {
    console.log('  Skipped memories had a type NorthKeep does not store; the app that wrote them can forget them.');
  }
  const unshown = down.needs_review.replacements.length + down.needs_review.forgets.length;
  if (unshown > 0) console.log(`  ${plural(unshown, 'change', 'changes')} arrived after the preview and wait for the next sync.`);
  for (const c of down.conflicts) console.log(`  Conflict, not applied: ${conflictLine(c)}. Resolve it with: northkeep share resolve ${c.project} --take-theirs | --keep-mine`);
  const after = await deps.withVault((vault) => vault.sharedScopes());
  for (const scope of after.filter((s) => !before.includes(s))) {
    console.log(
      `  "${scope}" came from a connected app and is now marked Shared. Later edits to it are pushed; run "northkeep share remove ${scope}" to stop.`,
    );
  }
  for (const scope of down.held_scopes) console.log(`  ${holdMessage(heldSlug(scope))}`);
  let push: PushSharedResult | null;
  try {
    push = await pushNow(cfg, deviceSecret, entitlement, deps);
  } catch (err) {
    fail(`The changes above were saved on this device, but Cloud Connect was not updated: ${message(err)}`);
  }
  if (push === null) {
    console.log(NOTHING_SHARED);
    return;
  }
  console.log(`✓ Re-pushed ${push.pushed} memories across ${push.scopes.length} shared scope(s) to ${cfg.server}.`);
}

/** `northkeep share conflicts [--show <slug>]`: what D1 is holding, and both texts side by side. */
export async function shareConflictsCmd(options: { show?: string }, deps: ShareDeps, fail: (m: string) => never): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  const entitlement = await maybeEntitlement(deviceSecret);
  const pending = await fetchPending({ server: cfg.server, deviceSecret, ...(entitlement ? { entitlement } : {}) });
  const report = await deps.withVault((vault) => {
    const plan = planDownSync({ vault, pending });
    if (options.show === undefined) return { conflicts: plan.conflicts, local: null, history: [] as string[] };
    let scope: string;
    try {
      scope = projectScope(options.show);
    } catch {
      return { conflicts: [], local: null, history: [], invalid: true };
    }
    const rows = vault.list({ scope, type: 'working', includeSuperseded: true });
    const head = rows.filter((r) => r.superseded_at === null);
    return {
      conflicts: plan.conflicts.filter((c) => c.scope === scope),
      local: head.length === 1 ? { id: head[0]!.id, content: head[0]!.content } : null,
      history: rows.filter((r) => r.superseded_at !== null).map((r) => r.content),
    };
  });
  if ('invalid' in report) fail('Project slug is invalid: use lowercase letters, digits and hyphens.');
  if (report.conflicts.length === 0) {
    console.log(options.show === undefined ? 'No conflicts are waiting.' : `No conflict is waiting for project ${options.show}.`);
    return;
  }
  if (options.show === undefined) {
    console.log(`${plural(report.conflicts.length, 'conflict is', 'conflicts are')} waiting:`);
    for (const c of report.conflicts) console.log(`  ${conflictLine(c)}`);
    console.log('  See both versions: northkeep share conflicts --show <project>');
    return;
  }
  console.log(report.local ? `This Mac's version (revision ${report.local.id}):` : 'This Mac has no current version of this project.');
  if (report.local) console.log(report.local.content);
  for (const c of report.conflicts) {
    console.log(`Cloud version (id ${c.server_id}; ${REASONS[c.reason]}):`);
    console.log(c.content);
    if (report.history.includes(c.content)) console.log('This cloud version is already in your history.');
  }
  console.log(
    `Keep one: northkeep share resolve ${options.show} --keep-mine, or --take-theirs${report.local ? ` --expected-revision ${report.local.id}` : ''} (refused if this Mac's version changes first)`,
  );
}

/** `northkeep share resolve <slug> --take-theirs|--keep-mine [--id <server id>]`, then push. */
export async function shareResolveCmd(
  slug: string,
  options: { takeTheirs?: boolean; keepMine?: boolean; id?: string; expectedRevision?: string },
  deps: ShareDeps,
  fail: (m: string) => never,
): Promise<void> {
  if (options.takeTheirs === options.keepMine) fail('Choose one: --take-theirs or --keep-mine.');
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  try {
    projectScope(slug);
  } catch {
    fail('Project slug is invalid: use lowercase letters, digits and hyphens.');
  }
  try {
    await assertDeviceCanPush({ vaultPath: deps.vaultPath, deviceSecret });
  } catch (err) {
    fail(`Nothing was changed. ${message(err)}`);
  }
  const entitlement = await maybeEntitlement(deviceSecret);
  const choice = options.takeTheirs ? 'take-theirs' : 'keep-mine';
  let resolved: Awaited<ReturnType<typeof resolveConflict>>;
  const now = new Date();
  try {
    resolved = await deps.withVault((vault) =>
      resolveConflict({
        server: cfg.server,
        deviceSecret,
        vault,
        project: slug,
        choice,
        now,
        ...(options.id ? { server_id: options.id } : {}),
        ...(options.expectedRevision ? { expected_revision: options.expectedRevision } : {}),
        ...(entitlement ? { entitlement } : {}),
      }),
    );
  } catch (err) {
    fail(message(err));
  }
  if (resolved.choice === 'take-theirs') {
    console.log(`✓ Project ${slug} now has the cloud version. Your previous version is in its history (northkeep projects history ${slug}).`);
  } else {
    console.log(
      `✓ Kept this Mac's version of ${slug}. The cloud version was saved as a memory in project:${slug} titled "Cloud version not kept, ${now.toISOString().slice(0, 10)}".`,
    );
  }
  try {
    await pushNow(cfg, deviceSecret, entitlement, deps);
    console.log('✓ Cloud Connect updated.');
  } catch (err) {
    fail(`Resolved on this device, but Cloud Connect was not updated: ${message(err)}`);
  }
}

/** `northkeep share auto [on|off]`: the D5 switch, stored on this device only. */
export function shareAutoCmd(setting: string | undefined, fail: (m: string) => never): void {
  if (setting === 'on' || setting === 'off') {
    try {
      setConnectorAutoPush(setting === 'on');
    } catch (err) {
      fail(message(err));
    }
  } else if (setting !== undefined) {
    fail('Use "on" or "off".');
  }
  console.log(
    connectorAutoPushEnabled()
      ? 'Automatic updates to Cloud Connect are on: after this device syncs, changes in shared scopes are pushed.'
      : 'Automatic updates to Cloud Connect are off: Cloud Connect updates only when you push.',
  );
}

export async function shareRemoveCmd(
  scope: string,
  withVault: WithVault,
  fail: (m: string) => never,
): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  let outcome: { deleted: number; wasShared: boolean } | { error: string; stage: 'server' | 'local' };
  outcome = await withVault(async (vault) => {
    foldSidecarScopesIntoVault(vault);
    const wasShared = vault.sharedScopes().includes(scope);
    // Server delete FIRST, local unmark second (same ordering as always): a
    // failed delete leaves the mark honestly in place rather than the vault
    // claiming private while the server still holds rows.
    let deleted: number;
    try {
      ({ deleted } = await unshareScope({ server: cfg.server, deviceSecret, scope }));
    } catch (err) {
      // Nothing to roll back: the fold-in saves itself, and the unmark never
      // happened, so the mark honestly stays until the server delete succeeds.
      return { error: message(err), stage: 'server' as const };
    }
    try {
      vault.setScopeShared(scope, false);
      vault.save();
    } catch (err) {
      return { error: message(err), stage: 'local' as const };
    }
    return { deleted, wasShared };
  });
  if ('error' in outcome) {
    const lead = outcome.stage === 'local' ? UNSHARE_LOCAL_SAVE_FAILED_MESSAGE : UNSHARE_FAILED_MESSAGE;
    fail(`${lead} (${outcome.error})`);
  }
  if (!outcome.wasShared) {
    console.log(`Scope '${scope}' was not marked shared. Unshared on the server anyway to be safe.`);
  }
  console.log(`✓ Scope '${scope}' unshared. Deleted ${outcome.deleted} memories from the connector server.`);
  console.log('  The unshare reaches your other devices with the next vault sync.');
}

export async function shareStatusCmd(withVault: WithVault): Promise<void> {
  const cfg = loadConnectorConfig();
  if (!cfg) {
    console.log('Sharing is not configured. Run: northkeep share server <url>');
    return;
  }
  console.log(`Connector server: ${cfg.server}`);
  const counts = await withVault((vault) => {
    foldSidecarScopesIntoVault(vault); // saves the vault itself when it folds
    return vault.sharedScopes().map((scope) => ({ scope, count: vault.list({ scope }).length }));
  });
  if (counts.length === 0) {
    console.log('Shared scopes: (none). Everything is private by default.');
    return;
  }
  console.log(
    'Shared scopes (stored encrypted on the connector, no key in its database to read them; the key is rebuilt per request ' +
      "from your app's credential plus a server-side secret, and the AI apps you connect read them in full). " +
      'Marks live in the vault, so they apply on every device that syncs it:',
  );
  for (const c of counts) console.log(`  ${c.scope}: ${c.count} ${c.count === 1 ? 'memory' : 'memories'}`);
  console.log(`Automatic updates: ${connectorAutoPushEnabled() ? 'on' : 'off'} (northkeep share auto on|off)`);
}

/**
 * `northkeep share id` — print the connector account id (sha256 of the connector
 * token). This is the value a connector operator adds to
 * NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES to comp an account (free access,
 * bypassing the subscription gate). It is a one-way hash: it identifies "an
 * account" but reveals nothing about the memories and decrypts nothing. The same
 * device secret on another machine yields the same id.
 */
export function shareIdCmd(fail: (m: string) => never): void {
  const deviceSecret = deviceSecretOrFail(fail);
  const accountHash = tokenHash(deriveConnectorToken(deviceSecret));
  console.log(`Your connector account id: ${accountHash}`);
  console.log('  Give this to the connector operator to be added to the free/comp allowlist.');
  console.log('  It identifies your account but reveals nothing about your memories.');
}

export async function shareCodeCmd(fail: (m: string) => never): Promise<void> {
  const cfg = requireConfig(fail);
  const deviceSecret = deviceSecretOrFail(fail);
  const entitlement = await maybeEntitlement(deviceSecret);
  let code: string;
  try {
    code = await startPairing({ server: cfg.server, deviceSecret, entitlement });
  } catch (err) {
    fail(message(err));
  }
  // This device now has an account on that server, which is what lets a later
  // sync fold from an empty shared list (ADR 0050 Decision 5).
  markConnectorPaired();
  console.log(`Pairing code: ${code}`);
  console.log('');
  console.log('Enter this code when connecting NorthKeep in Claude or ChatGPT.');
  console.log('It expires in 10 minutes and can be used once.');
}
