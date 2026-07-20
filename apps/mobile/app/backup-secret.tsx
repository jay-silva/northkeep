import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  // Deprecated in RN core but still shipped in 0.83; see CLIPBOARD NOTE below.
  Clipboard,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  type AppStateStatus,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Redirect, Stack, router } from 'expo-router';
import { formatDeviceSecretGroups } from '../src/lib/backup-flow';
import { loadDeviceSecretHex } from '../src/lib/secure-store';
import { useVaultSession } from '../src/lib/vault-session';
import { Button, ErrorNote, FieldLabel, colors } from '../src/ui';

/**
 * Back up the recovery secret (Phase A of phone-first onboarding). A person
 * whose ONLY device is this phone loses the vault if the phone is lost before
 * this secret is saved somewhere else, so after create-vault this screen is
 * mandatory: no skip, and Continue requires an explicit "I saved it"
 * confirmation. The secret is shown in the exact 64-hex form the device-link
 * manual paste accepts (grouped for reading; the parser strips whitespace).
 *
 * Reached two ways:
 *  - Onboarding: immediately after vault creation. Decided EXCLUSIVELY by the
 *    session's one-shot justCreatedVault flag (set by createVault, consumed
 *    here when the backup confirm completes). Never by URL params: the
 *    northkeep:// scheme deep-links any route, so trusting ?from=create would
 *    let `northkeep://backup-secret?from=create` show the secret with no auth
 *    even with the vault locked. No auth prompt (the user typed the
 *    passphrase seconds ago), back disabled, confirm mandatory.
 *  - From Settings ("Back up recovery secret"), and any deep link: gated
 *    behind the OS local authentication prompt, with the same locked/unlinked
 *    redirects as the other screens.
 *
 * CONSUME POINT for the one-shot flag: the confirm buttons ("Turn on sync" /
 * "Not now"), NOT mount. Backgrounding mid-backup locks the vault
 * (LockOnBackground) and this screen resets on return; because the flag is
 * still set, the reset re-derives onboarding mode and re-reveals the secret
 * without a prompt, instead of locking a fresh creator out of their own
 * mandatory backup step. If the app is killed mid-backup the in-memory flag is
 * gone; the user unlocks normally and can re-view the secret from Settings
 * behind the auth gate.
 *
 * CLIPBOARD NOTE: react-native's core Clipboard is deprecated in favor of the
 * extracted @react-native-clipboard/clipboard package, but it is still shipped
 * and compiled into RN 0.83, so using it costs no new native module and no new
 * dev-client build (a Phase A constraint). The secret Text is also selectable
 * as a fallback. Revisit when RN actually removes it.
 *
 * NEEDS ON-DEVICE VALIDATION: the LocalAuthentication prompt flow (including
 * the passcode-only and no-passcode paths), Clipboard.setString on a real
 * build, and whether the iOS app-switcher privacy cover (root layout) masks
 * this screen's secret.
 */
export default function BackupSecret() {
  const session = useVaultSession();
  // Onboarding mode is latched into screen state so consuming the flag on the
  // confirm buttons does not flip the screen back into the auth gate during
  // the navigation away. Re-derived from the session flag on every
  // background -> foreground return (see the AppState effect).
  const [onboarding, setOnboarding] = useState(session.justCreatedVault);
  const [secretHex, setSecretHex] = useState<string | null>(null);
  const [state, setState] = useState<'checking' | 'ready' | 'denied' | 'missing' | 'error'>(
    'checking',
  );
  const [noDeviceAuth, setNoDeviceAuth] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // Refs so reveal() and the AppState listener always see current values
  // without being re-created (re-creating reveal would re-run the mount
  // effect and re-prompt mid-session).
  const onboardingRef = useRef(onboarding);
  onboardingRef.current = onboarding;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const reveal = useCallback(async () => {
    setState('checking');
    setNoDeviceAuth(false);
    try {
      if (!onboardingRef.current) {
        // Re-view path: require the OS auth prompt before showing the secret.
        // getEnrolledLevelAsync also detects passcode-only devices
        // (SecurityLevel.SECRET); the old hasHardwareAsync + isEnrolledAsync
        // pair skipped the prompt on an iPhone with a passcode but no
        // biometrics enrolled. authenticateAsync falls back to the device
        // passcode by default, so the prompt works on those devices too.
        const level = await LocalAuthentication.getEnrolledLevelAsync();
        if (level !== LocalAuthentication.SecurityLevel.NONE) {
          const result = await LocalAuthentication.authenticateAsync({
            promptMessage: 'Show your recovery secret',
          });
          if (!result.success) {
            setState('denied');
            return;
          }
        } else {
          // The OS truly has no passcode and no biometrics: there is nothing
          // to gate with. Proceed, but say so instead of pretending a check ran.
          setNoDeviceAuth(true);
        }
      }
      const hex = await loadDeviceSecretHex();
      if (!hex) {
        setState('missing');
        return;
      }
      setSecretHex(hex);
      setState('ready');
    } catch {
      // A SecureStore or LocalAuthentication throw must not strand the screen
      // on "Preparing..." with back disabled; show a Retry instead.
      setState('error');
    }
  }, []);

  useEffect(() => {
    void reveal();
  }, [reveal]);

  // Background -> foreground: never keep a revealed secret on screen across a
  // trip through the app switcher. Clear it and re-run the auth-or-flag check.
  // LockOnBackground locks the VAULT on background, but this mounted screen
  // would otherwise still be showing the secret on return. In onboarding mode
  // the one-shot flag is still set (consumed on confirm, not on mount), so the
  // reset re-reveals without a prompt; on the re-view path the OS auth prompt
  // runs again.
  useEffect(() => {
    let wentBackground = false;
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background') {
        wentBackground = true;
        setSecretHex(null);
        setCopied(false);
        setState('checking');
      } else if (next === 'active' && wentBackground) {
        wentBackground = false;
        const fresh = sessionRef.current.justCreatedVault;
        onboardingRef.current = fresh;
        setOnboarding(fresh);
        void reveal();
      }
    });
    return () => sub.remove();
  }, [reveal]);

  // Re-view path only: match the other screens' session-status redirects, so a
  // deep link can never land here with the vault locked or the phone unlinked.
  // Onboarding is exempt on purpose: lock-on-background flips status to
  // 'locked' mid-backup, and the secret comes from SecureStore, not the vault.
  if (!onboarding) {
    if (session.status === 'locked') return <Redirect href="/unlock" />;
    if (session.status === 'unlinked') return <Redirect href="/onboarding" />;
  }

  function onCopy() {
    if (!secretHex) return;
    // Copy the RAW 64-hex form (no spaces): guaranteed to paste cleanly into
    // the device-link screen and into password-manager fields.
    Clipboard.setString(secretHex);
    setCopied(true);
  }

  function finishOnboarding(to: 'sync' | 'memories') {
    // Consume the one-shot flag only now, when the backup confirm completes,
    // so backgrounding mid-backup kept onboarding mode alive (see module doc).
    session.consumeJustCreatedVault();
    if (to === 'sync') {
      router.replace({ pathname: '/sync-setup', params: { from: 'onboarding' } });
    } else {
      router.replace('/memories');
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* First run is a one-way door: no back-swipe out of the backup step. */}
      <Stack.Screen options={{ headerBackVisible: !onboarding, gestureEnabled: !onboarding }} />

      <Text style={styles.title}>Save your recovery secret</Text>
      <Text style={styles.body}>
        This is your recovery secret. It pairs with your passphrase: you need both to open your
        vault on a new phone. NorthKeep never sees either one and cannot recover them for you.
      </Text>
      <Text style={styles.body}>
        Save it in a password manager, or write it down and keep it somewhere safe. If you lose
        this phone without a copy of this secret, your vault is gone.
      </Text>

      {state === 'checking' ? <Text style={styles.body}>Preparing...</Text> : null}

      {state === 'denied' ? (
        <>
          <ErrorNote message="Authentication is required to show the recovery secret." />
          <Button title="Try again" onPress={() => void reveal()} />
        </>
      ) : null}

      {state === 'error' ? (
        <>
          <ErrorNote message="Something went wrong while preparing your recovery secret." />
          <Button title="Retry" onPress={() => void reveal()} />
        </>
      ) : null}

      {state === 'missing' ? (
        <ErrorNote message="There is no device secret on this phone yet. Create or link a vault first." />
      ) : null}

      {state === 'ready' && secretHex ? (
        <>
          {noDeviceAuth ? (
            <Text style={styles.warnNote}>
              This phone has no passcode or biometrics set up, so the secret is shown without an
              authentication check. Anyone who can open this phone could view it.
            </Text>
          ) : null}
          <FieldLabel>Your recovery secret</FieldLabel>
          <View style={styles.secretCard}>
            <Text style={styles.secretText} selectable>
              {formatDeviceSecretGroups(secretHex)}
            </Text>
          </View>
          <Button title="Copy secret" kind="secondary" onPress={onCopy} />
          {copied ? (
            <Text style={styles.notice}>
              Copied. Paste it into your password manager now, then copy something else so the
              secret does not sit on the clipboard.
            </Text>
          ) : null}

          {onboarding ? (
            <>
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>I saved my recovery secret</Text>
                <Switch value={confirmed} onValueChange={setConfirmed} />
              </View>
              <Text style={styles.footnote}>
                Next, you can turn on sync to keep an end-to-end encrypted copy of your vault on
                your account.
              </Text>
              <Button
                title="Turn on sync"
                onPress={() => finishOnboarding('sync')}
                disabled={!confirmed}
                style={styles.stackedButton}
              />
              <Button
                title="Not now"
                kind="secondary"
                onPress={() => finishOnboarding('memories')}
                disabled={!confirmed}
                style={styles.stackedButton}
              />
            </>
          ) : (
            <Button title="Done" onPress={() => router.back()} style={styles.stackedButton} />
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 48 },
  title: { color: colors.text, fontSize: 26, fontWeight: '700', marginBottom: 8 },
  body: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 8 },
  warnNote: { color: colors.warnText, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  secretCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
  },
  secretText: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 26,
    letterSpacing: 0.5,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  notice: { color: '#4cc38a', fontSize: 13, lineHeight: 19, marginTop: 8 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 16,
    gap: 12,
  },
  switchLabel: { color: colors.text, fontSize: 14, flex: 1, lineHeight: 20 },
  footnote: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 12 },
  stackedButton: { marginTop: 12 },
});
