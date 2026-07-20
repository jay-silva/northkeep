import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View, type AppStateStatus } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { initMobilePlatform } from '../src/platform';
import { VaultSessionProvider, useVaultSession } from '../src/lib/vault-session';
import { WarningBanner, colors } from '../src/ui';
import { BottomNav } from '../src/BottomNav';

function LockOnBackground({ children }: { children: React.ReactNode }) {
  const session = useVaultSession();
  const lockRef = useRef(session.lock);
  lockRef.current = session.lock;

  useEffect(() => {
    // Vault locks when the app leaves the foreground (plan: lock-on-background,
    // the mobile analog of the desktop's session posture). The biometric key
    // cache in the keychain survives, so reopening is one Face ID prompt.
    // 'background' only, not 'inactive': iOS fires 'inactive' for transient
    // overlays (notification shade, system dialogs) where relocking would thrash.
    // NEEDS ON-DEVICE VALIDATION: AppState transitions and the M6-5
    // app-switcher snapshot blur are device-only behaviors.
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background') void lockRef.current();
    });
    return () => sub.remove();
  }, []);

  return <>{children}</>;
}

/**
 * Privacy cover for the iOS app-switcher snapshot (M6-5 security). iOS captures a
 * snapshot of the app when it leaves the foreground and shows it in the
 * multitasking switcher; without a cover, unlocked vault plaintext would be
 * visible there. We paint an opaque NorthKeep screen whenever AppState is not
 * 'active' — the snapshot is taken during 'inactive', so it captures the cover,
 * not the memories. Complements lock-on-background (which zeroizes the key on
 * 'background'); this closes the brief 'inactive' window before that fires.
 */
function PrivacyCover() {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      setCovered(next !== 'active');
    });
    return () => sub.remove();
  }, []);
  if (!covered) return null;
  return (
    <View style={styles.cover} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text style={styles.coverMark}>NorthKeep</Text>
    </View>
  );
}

export default function RootLayout() {
  // Register the platform adapters once at startup (async: the RN libsodium
  // binding must reach sodium.ready first). Gate the screens until it resolves
  // so nothing touches the vault before getPlatform() is set; a failure shows a
  // persistent banner instead of crashing (invariant #6: degrade loudly).
  const [init, setInit] = useState<{ ready: boolean; error: string | null }>({
    ready: false,
    error: null,
  });
  useEffect(() => {
    let active = true;
    void initMobilePlatform().then((error) => {
      if (active) setInit({ ready: true, error });
    });
    return () => {
      active = false;
    };
  }, []);

  if (!init.ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.text} />
        <Text style={{ color: colors.text, marginTop: 12 }}>Starting NorthKeep</Text>
      </View>
    );
  }

  return (
    <VaultSessionProvider>
      <LockOnBackground>
        <StatusBar style="light" />
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <WarningBanner
            message={
              init.error
                ? `NorthKeep cannot open vaults on this build: ${init.error}`
                : null
            }
          />
          <View style={{ flex: 1 }}>
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.bg },
                headerTintColor: colors.text,
                contentStyle: { backgroundColor: colors.bg },
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="onboarding" options={{ headerShown: false }} />
              <Stack.Screen name="device-link" options={{ title: 'Link your Mac' }} />
              <Stack.Screen name="create-vault" options={{ title: 'Start a new vault' }} />
              {/* Phase A phone-first onboarding: mandatory backup step after
                  create-vault (the screen itself hides back on first run), then
                  the optional enable-sync step. Both also reachable from Settings. */}
              <Stack.Screen name="backup-secret" options={{ title: 'Recovery secret' }} />
              <Stack.Screen name="sync-setup" options={{ title: 'Sync' }} />
              <Stack.Screen name="demo" options={{ title: 'Demo', headerBackVisible: false }} />
              <Stack.Screen name="unlock" options={{ title: 'Unlock', headerBackVisible: false }} />
              <Stack.Screen name="memories" options={{ title: 'Memories', headerBackVisible: false }} />
              <Stack.Screen name="memory/new" options={{ title: 'Add memory', presentation: 'modal' }} />
              <Stack.Screen name="memory/[id]" options={{ title: 'Memory' }} />
              {/* Section screens: no back arrow — the bottom nav switches between them. */}
              <Stack.Screen name="converse" options={{ title: 'Converse', headerBackVisible: false }} />
              <Stack.Screen name="settings" options={{ title: 'Settings', headerBackVisible: false }} />
              {/* Pushed detail screens from Converse (keep the back arrow). */}
              <Stack.Screen name="providers" options={{ title: 'Providers' }} />
              <Stack.Screen name="converse-audit" options={{ title: 'What left this device' }} />
              <Stack.Screen name="model-eval" options={{ title: 'On-device model eval' }} />
              {/* Phase B Cloud Connect: pushed from Settings and the journal
                  guide (keep the back arrow). */}
              <Stack.Screen name="sharing" options={{ title: 'Cloud Connect' }} />
              <Stack.Screen name="journal-setup" options={{ title: 'AI journal' }} />
            </Stack>
          </View>
          <BottomNav />
          <PrivacyCover />
        </View>
      </LockOnBackground>
    </VaultSessionProvider>
  );
}

const styles = StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  coverMark: { color: colors.accent, fontSize: 26, fontWeight: '700', letterSpacing: 0.5 },
});
