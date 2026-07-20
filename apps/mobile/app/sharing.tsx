import React, { useEffect, useState } from 'react';
import {
  // Deprecated in RN core but still shipped in 0.83; same tradeoff as
  // backup-secret.tsx (no new native module, Phase A/B constraint).
  Clipboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { memzero } from '@northkeep/core';
import { assertConnectorUrl, deriveConnectorToken } from '@northkeep/sync';
import {
  DEFAULT_CONNECTOR_SERVER_URL,
  PAIRING_CODE_TTL_SECONDS,
  classifyConnectorError,
  connectorSyncSummary,
  formatPairingCountdown,
  mcpUrlFor,
  runConnectorSyncNow,
  runShareScope,
  runUnshareScope,
  scopeRows,
  shareIdFromConnectorToken,
  type ConnectorFailure,
  type SharedScopeStore,
} from '../src/lib/connect-flow';
import {
  loadConnectorServerUrl,
  loadConnectorSharedScopes,
  loadDeviceSecretHex,
  saveConnectorServerUrl,
  saveConnectorSharedScopes,
} from '../src/lib/secure-store';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors } from '../src/ui';

/**
 * Cloud Connect (Phase B of phone-first onboarding): share chosen scopes to
 * the hosted connector, pair AI apps, and pull app-written memories back, all
 * from the phone. Invariant #1 is the spine of this screen: private is the
 * default, sharing is per-scope and opt-in, the confirmation is LOUD and
 * honest about plaintext leaving the phone, the Shared state is visible on
 * every row, and unshare deletes server-side. All state transitions live in
 * the pure, tested src/lib/connect-flow.ts; this screen renders outcomes.
 *
 * App Store steering (WS4): a 402 renders the neutral subscription copy from
 * connect-flow. No price, no link, no purchase instruction, ever.
 *
 * NEEDS ON-DEVICE VALIDATION: every network path here (push, unshare, pair,
 * down-sync, entitlement) against the live connector server; the beta 402 for
 * a non-allowlisted account is the expected live path.
 */
export default function Sharing() {
  const session = useVaultSession();
  const params = useLocalSearchParams<{ share?: string }>();

  const [savedServer, setSavedServer] = useState<string | null>(null);
  const [serverInput, setServerInput] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverNotice, setServerNotice] = useState<string | null>(null);

  const [shareId, setShareId] = useState<string | null>(null);
  const [sharedScopes, setSharedScopes] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [pendingShare, setPendingShare] = useState<string | null>(null);
  const [pendingUnshare, setPendingUnshare] = useState<string | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeError, setScopeError] = useState<ConnectorFailure | null>(null);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);

  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<ConnectorFailure | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copiedWhat, setCopiedWhat] = useState<string | null>(null);

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<ConnectorFailure | null>(null);

  // Bootstrap: server, shared list, share id; then honor ?share=scope from the
  // journal guide by preselecting that scope's confirmation.
  useEffect(() => {
    void (async () => {
      const server = await loadConnectorServerUrl();
      setSavedServer(server);
      setServerInput(server ?? DEFAULT_CONNECTOR_SERVER_URL);
      const scopes = await loadConnectorSharedScopes();
      setSharedScopes(scopes);
      setShareId(await computeShareId());
      const wanted = typeof params.share === 'string' ? params.share : null;
      if (wanted && !scopes.includes(wanted)) setPendingShare(wanted);
      setLoaded(true);
    })();
    // Bootstrap runs once; params.share only preselects on entry.
  }, []);

  // 1-second tick for the pairing-code countdown while a code is showing.
  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pair]);

  if (session.status === 'locked') return <Redirect href="/unlock" />;
  if (session.status === 'unlinked') return <Redirect href="/onboarding" />;

  const effectiveServer = savedServer ?? DEFAULT_CONNECTOR_SERVER_URL;
  const mcpUrl = mcpUrlFor(effectiveServer);
  const rows = scopeRows(session.entries, sharedScopes);
  const store: SharedScopeStore = {
    load: () => loadConnectorSharedScopes(),
    save: (scopes) => saveConnectorSharedScopes(scopes),
  };
  const pairSecondsLeft = pair ? Math.round((pair.expiresAt - nowMs) / 1000) : 0;
  const pairExpired = pair !== null && pairSecondsLeft <= 0;

  function copy(label: string, value: string) {
    Clipboard.setString(value);
    setCopiedWhat(label);
  }

  function onSaveServer() {
    setServerError(null);
    setServerNotice(null);
    void (async () => {
      try {
        // Same https-or-loopback rule as desktop (@northkeep/sync).
        const normalized = assertConnectorUrl(serverInput.trim()).toString().replace(/\/$/, '');
        await saveConnectorServerUrl(normalized);
        setSavedServer(normalized);
        setServerInput(normalized);
        setServerNotice('Connector server saved.');
      } catch (err) {
        setServerError(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  function onConfirmShare(scope: string) {
    setScopeBusy(true);
    setScopeError(null);
    setScopeNotice(null);
    void (async () => {
      const outcome = await runShareScope(
        { store, pushScopes: (scopes) => session.connectorPushScopes(scopes) },
        scope,
      );
      setScopeBusy(false);
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
    setScopeBusy(true);
    setScopeError(null);
    setScopeNotice(null);
    void (async () => {
      const outcome = await runUnshareScope(
        { store, unshare: (s) => session.connectorUnshareScope(s) },
        scope,
      );
      setScopeBusy(false);
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

  function onPair() {
    setPairBusy(true);
    setPairError(null);
    void (async () => {
      try {
        const code = await session.connectorStartPairing();
        setNowMs(Date.now());
        setPair({ code, expiresAt: Date.now() + PAIRING_CODE_TTL_SECONDS * 1000 });
      } catch (err) {
        setPairError(classifyConnectorError(err));
      } finally {
        setPairBusy(false);
      }
    })();
  }

  function onSyncNow() {
    setSyncBusy(true);
    setSyncError(null);
    setSyncResult(null);
    void (async () => {
      const outcome = await runConnectorSyncNow({
        store,
        downSync: () => session.connectorDownSync(),
        pushScopes: (scopes) => session.connectorPushScopes(scopes),
      });
      setSyncBusy(false);
      if (outcome.kind === 'synced') setSyncResult(connectorSyncSummary(outcome));
      else if (outcome.kind === 'nothing-shared') setSyncResult(outcome.message);
      else setSyncError(outcome);
    })();
  }

  const pendingCount = pendingShare
    ? rows.find((r) => r.scope === pendingShare)?.count ?? 0
    : 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.body}>
        Cloud Connect makes chosen memories usable inside the AI apps you already use (Claude,
        ChatGPT, Manus) by copying them to NorthKeep's connector server. Everything is private by
        default. You share one scope at a time, on purpose, and you can unshare anytime.
      </Text>
      <View style={styles.banner}>
        <Text style={styles.bannerStrong}>
          Sharing is different from Sync. The connector server can read what you share.
        </Text>
        <Text style={styles.bannerBody}>
          Sync stores your vault as encrypted data the server can never read. Sharing copies a
          scope's memories in plain, readable form so your AI apps can reach them. Only scopes you
          turn on here ever leave this phone.
        </Text>
      </View>

      <FieldLabel>Connector server</FieldLabel>
      <Info label="Server" value={effectiveServer} />
      <Info label="Connector URL for your AI apps" value={mcpUrl} />
      <Pressable onPress={() => copy('mcp', mcpUrl)} accessibilityRole="button">
        <Text style={styles.copyLink}>{copiedWhat === 'mcp' ? 'Copied.' : 'Copy connector URL'}</Text>
      </Pressable>
      <Pressable onPress={() => setAdvancedOpen((v) => !v)} accessibilityRole="button">
        <Text style={styles.copyLink}>{advancedOpen ? 'Hide advanced' : 'Advanced: use a custom server'}</Text>
      </Pressable>
      {advancedOpen ? (
        <>
          <TextInput
            style={styles.input}
            value={serverInput}
            onChangeText={setServerInput}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={DEFAULT_CONNECTOR_SERVER_URL}
            placeholderTextColor={colors.muted}
          />
          <Button
            title="Save connector server"
            kind="secondary"
            onPress={onSaveServer}
            disabled={serverInput.trim().length === 0}
          />
          <ErrorNote message={serverError} />
          {serverNotice ? <Text style={styles.notice}>{serverNotice}</Text> : null}
        </>
      ) : null}

      <FieldLabel>Your share id</FieldLabel>
      <View style={styles.monoCard}>
        <Text style={styles.monoText} selectable>
          {shareId ?? (loaded ? 'Unavailable (no device secret on this phone yet).' : 'Loading...')}
        </Text>
      </View>
      {shareId ? (
        <Pressable onPress={() => copy('shareid', shareId)} accessibilityRole="button">
          <Text style={styles.copyLink}>{copiedWhat === 'shareid' ? 'Copied.' : 'Copy share id'}</Text>
        </Pressable>
      ) : null}
      <Text style={styles.footnote}>
        Send this to support to join the beta. It identifies your sharing account only; it reveals
        nothing about your vault and cannot decrypt anything.
      </Text>

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
            disabled={scopeBusy}
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
            busy={scopeBusy}
            style={styles.stackedButton}
          />
          <Button
            title="Cancel"
            kind="secondary"
            onPress={() => setPendingShare(null)}
            disabled={scopeBusy}
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
            busy={scopeBusy}
            style={styles.stackedButton}
          />
          <Button
            title="Cancel"
            kind="secondary"
            onPress={() => setPendingUnshare(null)}
            disabled={scopeBusy}
            style={styles.stackedButton}
          />
        </View>
      ) : null}

      {scopeError ? <ErrorNote message={scopeError.message} /> : null}
      {scopeNotice ? <Text style={styles.notice}>{scopeNotice}</Text> : null}

      <FieldLabel>Pair an AI app</FieldLabel>
      <Text style={styles.footnote}>
        Generate a one-time code, then add NorthKeep as a connector in Claude, ChatGPT, or Manus.
        You only do this once per app.
      </Text>
      <Button
        title={pair ? 'New code' : 'Pair an AI app'}
        kind={pair ? 'secondary' : 'primary'}
        onPress={onPair}
        busy={pairBusy}
        style={styles.stackedButton}
      />
      {pairError ? <ErrorNote message={pairError.message} /> : null}
      {pair ? (
        <View style={styles.pairCard}>
          <Text style={styles.pairLabel}>Pairing code</Text>
          <Text style={styles.pairCode} selectable>
            {pair.code}
          </Text>
          <Text style={styles.pairCountdown}>
            {pairExpired
              ? 'This code expired. Generate a new one.'
              : `Expires in ${formatPairingCountdown(pairSecondsLeft)}`}
          </Text>
          <Pressable onPress={() => copy('code', pair.code)} accessibilityRole="button">
            <Text style={styles.copyLink}>{copiedWhat === 'code' ? 'Copied.' : 'Copy code'}</Text>
          </Pressable>
          <Text style={styles.pairLabel}>Connector URL</Text>
          <Text style={styles.monoText} selectable>
            {mcpUrl}
          </Text>
          <Pressable onPress={() => copy('mcp2', mcpUrl)} accessibilityRole="button">
            <Text style={styles.copyLink}>{copiedWhat === 'mcp2' ? 'Copied.' : 'Copy connector URL'}</Text>
          </Pressable>
          <Text style={styles.confirmBody}>
            In your AI app, add a custom connector (an MCP server) with this URL. When the app
            opens NorthKeep's consent page, enter this code and approve.
          </Text>
          <Text style={styles.pairWarning}>
            Treat this pairing code like a key. Enter it only on the consent page your AI app
            opens. NorthKeep will never ask you for it.
          </Text>
        </View>
      ) : null}

      <FieldLabel>Sync app-written memories</FieldLabel>
      <Text style={styles.footnote}>
        Pull memories you created (or forgot) inside your AI apps back into this vault, then
        re-push so the server matches. Runs only on your shared scopes.
      </Text>
      <Button
        title="Sync app-written memories"
        kind="secondary"
        onPress={onSyncNow}
        busy={syncBusy}
        disabled={sharedScopes.length === 0}
        style={styles.stackedButton}
      />
      {syncError ? <ErrorNote message={syncError.message} /> : null}
      {syncResult ? <Text style={styles.notice}>{syncResult}</Text> : null}
    </ScrollView>
  );
}

/**
 * The beta "share id": tokenHash(deriveConnectorToken(deviceSecret)), the same
 * value `northkeep share id` prints on desktop and the connector allowlist
 * stores. Derivation goes through the platform seam (BLAKE2b) + noble sha256;
 * the secret buffer is zeroed immediately after.
 */
async function computeShareId(): Promise<string | null> {
  try {
    const hex = await loadDeviceSecretHex();
    if (!hex) return null;
    const secret = Buffer.from(hex, 'hex');
    try {
      return shareIdFromConnectorToken(deriveConnectorToken(secret));
    } finally {
      memzero(secret);
    }
  } catch {
    return null;
  }
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  body: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 8 },
  banner: {
    backgroundColor: colors.warnBg,
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  bannerStrong: { color: colors.warnText, fontSize: 13, fontWeight: '700', lineHeight: 19 },
  bannerBody: { color: colors.warnText, fontSize: 13, lineHeight: 19, marginTop: 6 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    fontSize: 15,
    marginBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  infoLabel: { color: colors.muted, fontSize: 14 },
  infoValue: { color: colors.text, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  copyLink: { color: colors.accent, fontSize: 14, fontWeight: '600', paddingVertical: 8 },
  monoCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  monoText: { color: colors.text, fontSize: 13, lineHeight: 20, fontFamily: mono },
  footnote: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 8 },
  notice: { color: '#4cc38a', fontSize: 13, lineHeight: 19, marginVertical: 8 },
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
  scopeTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  scopeCount: { color: colors.muted, fontSize: 12, marginTop: 2 },
  confirmCard: {
    backgroundColor: colors.card,
    borderColor: colors.warnText,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 8,
    marginBottom: 8,
  },
  confirmTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  confirmBody: { color: colors.text, fontSize: 14, lineHeight: 20, marginBottom: 8 },
  pairCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 8,
  },
  pairLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
    marginBottom: 4,
  },
  pairCode: {
    color: colors.text,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 4,
    fontFamily: mono,
  },
  pairCountdown: { color: colors.warnText, fontSize: 13, fontWeight: '600', marginTop: 4 },
  pairWarning: { color: colors.warnText, fontSize: 13, lineHeight: 19, fontWeight: '600' },
  stackedButton: { marginTop: 12 },
});
