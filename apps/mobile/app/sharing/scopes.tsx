import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Redirect, useLocalSearchParams } from 'expo-router';
import {
  SYNC_PUSH_FAILED_FOLLOWUP,
  SYNC_PUSH_SKIPPED_ALL_UNSHARED_MESSAGE,
  connectorSyncSummary,
  runConnectorSyncNow,
  runShareScope,
  runUnshareScope,
  scopeRows,
  type ConnectorFailure,
  type SharedScopeStore,
} from '../../src/lib/connect-flow';
import {
  loadConnectorSharedScopes,
  saveConnectorSharedScopes,
} from '../../src/lib/secure-store';
import { useVaultSession } from '../../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors, type } from '../../src/ui';

/**
 * Manage sharing (Wave 3): the per-scope Share toggles, the LOUD plaintext
 * confirmation (invariant #1: private by default, per-scope opt-in, honest about
 * plaintext leaving the phone, unshare deletes server-side), AND Sync
 * app-written memories.
 *
 * WHY SYNC LIVES HERE, not on its own screen: share, unshare, and sync share ONE
 * mutual-exclusion lock (`connectorBusy`). That single lock is invariant-#1
 * safety, not cosmetics -- independent busy flags once let an unshare complete
 * while a sync-now was mid-flight, and the sync's write-back push re-uploaded the
 * just-revoked scope's plaintext. Keeping all three in one component keeps the
 * one lock intact (popping a screen does not abort an in-flight push). All state
 * transitions live in the pure, tested src/lib/connect-flow.ts.
 *
 * Entry: /sharing/scopes, or /sharing/scopes?share=<scope> from the journal
 * guide, which preselects that scope's confirmation on entry.
 */
export default function ManageScopes() {
  const session = useVaultSession();
  const params = useLocalSearchParams<{ share?: string }>();

  const [sharedScopes, setSharedScopes] = useState<string[]>([]);

  const [pendingShare, setPendingShare] = useState<string | null>(null);
  const [pendingUnshare, setPendingUnshare] = useState<string | null>(null);
  // ONE mutual exclusion across share / unshare / sync-now. Independent busy
  // flags allowed an unshare to complete while a sync-now was mid-flight, and
  // the sync's write-back push would re-upload the just-revoked scope's
  // plaintext (connect-flow's fresh re-load before the push is the second,
  // belt-and-braces layer of the same fix).
  const [connectorBusy, setConnectorBusy] = useState<'share' | 'unshare' | 'sync' | null>(null);
  const [scopeError, setScopeError] = useState<ConnectorFailure | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);

  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<ConnectorFailure | null>(null);

  // Bootstrap: shared list; then honor ?share=scope from the journal guide by
  // preselecting that scope's confirmation. Runs once; params.share only
  // preselects on entry.
  useEffect(() => {
    void (async () => {
      const scopes = await loadConnectorSharedScopes();
      setSharedScopes(scopes);
      const wanted = typeof params.share === 'string' ? params.share : null;
      if (wanted && !scopes.includes(wanted)) setPendingShare(wanted);
    })();
  }, []);

  if (session.status === 'locked') return <Redirect href="/unlock" />;
  if (session.status === 'unlinked') return <Redirect href="/onboarding" />;

  const rows = scopeRows(session.entries, sharedScopes);
  const store: SharedScopeStore = {
    load: () => loadConnectorSharedScopes(),
    save: (scopes) => saveConnectorSharedScopes(scopes),
  };

  function onConfirmShare(scope: string) {
    if (connectorBusy) return;
    setConnectorBusy('share');
    setScopeError(null);
    setScopeNotice(null);
    void (async () => {
      const outcome = await runShareScope(
        { store, pushScopes: (scopes) => session.connectorPushScopes(scopes) },
        scope,
      );
      setConnectorBusy(null);
      if (outcome.kind === 'shared') {
        setSharedScopes(await loadConnectorSharedScopes());
        setPendingShare(null);
        setScopeNotice(
          `"${outcome.scope}" is shared. ${outcome.pushed} ${outcome.pushed === 1 ? 'memory' : 'memories'} on the connector now match your vault.`,
        );
      } else {
        // The local mark was rolled back by runShareScope; the row stays Private.
        setScopeError(outcome);
      }
    })();
  }

  function onConfirmUnshare(scope: string) {
    if (connectorBusy) return;
    setConnectorBusy('unshare');
    setScopeError(null);
    setScopeNotice(null);
    void (async () => {
      const outcome = await runUnshareScope(
        { store, unshare: (s) => session.connectorUnshareScope(s) },
        scope,
      );
      setConnectorBusy(null);
      setPendingUnshare(null);
      if (outcome.kind === 'unshared') {
        setSharedScopes(await loadConnectorSharedScopes());
        setScopeNotice(`"${outcome.scope}" is private again. The server copies were deleted.`);
      } else {
        // Honest failure: the server still holds the copies, so the mark stays.
        setScopeError({
          ...outcome,
          message: `${outcome.message} The server copies were not removed, so the scope is still marked Shared.`,
        });
      }
    })();
  }

  function onSyncNow() {
    if (connectorBusy) return;
    setConnectorBusy('sync');
    setSyncError(null);
    setSyncResult(null);
    void (async () => {
      const outcome = await runConnectorSyncNow({
        store,
        downSync: () => session.connectorDownSync(),
        pushScopes: (scopes) => session.connectorPushScopes(scopes),
      });
      setConnectorBusy(null);
      if (outcome.kind === 'synced') {
        setSyncResult(connectorSyncSummary(outcome));
      } else if (outcome.kind === 'synced-no-push') {
        // Every scope was unshared while the sync ran; the push was skipped so
        // no revoked plaintext went back up. Say so honestly.
        setSyncResult(
          `${connectorSyncSummary(outcome, { pushedBack: false })} ${SYNC_PUSH_SKIPPED_ALL_UNSHARED_MESSAGE}`,
        );
        setSharedScopes(await loadConnectorSharedScopes());
      } else if (outcome.kind === 'partially-synced') {
        // Both halves stay visible: the memories arrived AND the re-push failed.
        setSyncResult(connectorSyncSummary(outcome, { pushedBack: false }));
        setSyncError({
          ...outcome.pushFailure,
          message: `${outcome.pushFailure.message} ${SYNC_PUSH_FAILED_FOLLOWUP}`,
        });
      } else if (outcome.kind === 'nothing-shared') {
        setSyncResult(outcome.message);
      } else {
        setSyncError(outcome);
      }
    })();
  }

  const pendingCount = pendingShare
    ? rows.find((r) => r.scope === pendingShare)?.count ?? 0
    : 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.reminder}>
        <Text style={styles.reminderText}>
          The connector server can read the scopes you share. Everything else stays on this phone.
        </Text>
      </View>
      <FieldLabel>Scopes</FieldLabel>
      <Text style={styles.footnote}>
        Every scope is private until you turn Share on. Turning it on shows a confirmation first.
      </Text>
      {rows.length === 0 ? (
        <Text style={styles.footnote}>No scopes yet. Add memories, then share a scope here.</Text>
      ) : null}
      {rows.map((row) => (
        <View key={row.scope} style={styles.scopeRow}>
          <View style={styles.scopeName}>
            <Text style={styles.scopeTitle}>{row.scope}</Text>
            <Text style={styles.scopeCount}>
              {row.count} {row.count === 1 ? 'memory' : 'memories'}
              {row.shared ? '  ·  SHARED' : ''}
            </Text>
          </View>
          <Switch
            value={row.shared}
            disabled={connectorBusy !== null}
            onValueChange={(next) => {
              setScopeError(null);
              setScopeNotice(null);
              if (next) {
                setPendingUnshare(null);
                setPendingShare(row.scope); // the confirm card drives the real change
              } else {
                setPendingShare(null);
                setPendingUnshare(row.scope);
              }
            }}
            accessibilityLabel={row.shared ? `Unshare ${row.scope}` : `Share ${row.scope}`}
          />
        </View>
      ))}

      {pendingShare ? (
        <View style={styles.confirmCard}>
          <Text style={styles.confirmTitle}>Share "{pendingShare}"?</Text>
          <Text style={styles.confirmBody}>
            The {pendingCount} {pendingCount === 1 ? 'memory' : 'memories'} in "{pendingShare}"
            will be copied off this phone to NorthKeep's connector server in plaintext-readable
            form, so the AI apps you pair can read them.
          </Text>
          <Text style={styles.confirmBody}>
            The connector stores shared memories encrypted at rest, but it can read them to serve
            your AI apps. Scope names, memory counts, and sizes are visible to the server as
            metadata.
          </Text>
          <Text style={styles.confirmBody}>
            Every scope you have not shared stays on this phone. Unsharing deletes the server
            copies; your vault keeps everything.
          </Text>
          <Button
            title="Share this scope"
            onPress={() => onConfirmShare(pendingShare)}
            busy={connectorBusy === 'share'}
            disabled={connectorBusy !== null}
            style={styles.stackedButton}
          />
          <Button
            title="Cancel"
            kind="secondary"
            onPress={() => setPendingShare(null)}
            disabled={connectorBusy !== null}
            style={styles.stackedButton}
          />
        </View>
      ) : null}

      {pendingUnshare ? (
        <View style={styles.confirmCard}>
          <Text style={styles.confirmTitle}>Unshare "{pendingUnshare}"?</Text>
          <Text style={styles.confirmBody}>
            This removes the server copies of these memories, so your paired AI apps can no longer
            read them. Your vault keeps everything.
          </Text>
          <Button
            title="Unshare"
            onPress={() => onConfirmUnshare(pendingUnshare)}
            busy={connectorBusy === 'unshare'}
            disabled={connectorBusy !== null}
            style={styles.stackedButton}
          />
          <Button
            title="Cancel"
            kind="secondary"
            onPress={() => setPendingUnshare(null)}
            disabled={connectorBusy !== null}
            style={styles.stackedButton}
          />
        </View>
      ) : null}

      {scopeError ? <ErrorNote message={scopeError.message} /> : null}
      {scopeNotice ? <Text style={styles.notice}>{scopeNotice}</Text> : null}

      <FieldLabel>Sync app-written memories</FieldLabel>
      <Text style={styles.footnote}>
        Pull memories you created (or forgot) inside your AI apps back into this vault, then
        re-push so the server matches. Runs only on your shared scopes.
      </Text>
      <Button
        title="Sync app-written memories"
        kind="secondary"
        onPress={onSyncNow}
        busy={connectorBusy === 'sync'}
        disabled={connectorBusy !== null || sharedScopes.length === 0}
        style={styles.stackedButton}
      />
      {syncError ? <ErrorNote message={syncError.message} /> : null}
      {syncResult ? <Text style={styles.notice}>{syncResult}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  reminder: { backgroundColor: colors.warnBg, borderRadius: 8, padding: 12, marginBottom: 4 },
  reminderText: { ...type.footnote, color: colors.warnText, fontWeight: '600' },
  footnote: { ...type.footnote, color: colors.muted, marginBottom: 8 },
  notice: { ...type.footnote, color: '#4cc38a', marginVertical: 8 },
  scopeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  scopeName: { flexShrink: 1 },
  scopeTitle: { ...type.body, color: colors.text, fontWeight: '600' },
  scopeCount: { ...type.caption, color: colors.muted, fontWeight: '400', marginTop: 2 },
  confirmCard: {
    backgroundColor: colors.card,
    borderColor: colors.warnText,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 8,
    marginBottom: 8,
  },
  confirmTitle: { ...type.headline, color: colors.text, marginBottom: 8 },
  confirmBody: { ...type.subhead, color: colors.text, marginBottom: 8 },
  stackedButton: { marginTop: 12 },
});
