import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Text, View, type AppStateStatus } from 'react-native';
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
              <Stack.Screen name="unlock" options={{ title: 'Unlock', headerBackVisible: false }} />
              <Stack.Screen name="memories" options={{ title: 'Memories', headerBackVisible: false }} />
              <Stack.Screen name="memory/new" options={{ title: 'Add memory', presentation: 'modal' }} />
              <Stack.Screen name="memory/[id]" options={{ title: 'Memory' }} />
              {/* Section screens: no back arrow — the bottom nav switches between them. */}
              <Stack.Screen name="converse" options={{ title: 'Converse', headerBackVisible: false }} />
              <Stack.Screen name="settings" options={{ title: 'Settings', headerBackVisible: false }} />
            </Stack>
          </View>
          <BottomNav />
        </View>
      </LockOnBackground>
    </VaultSessionProvider>
  );
}
