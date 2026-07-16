import React, { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { initMobilePlatform } from '../src/platform';
import { VaultSessionProvider, useVaultSession } from '../src/lib/vault-session';
import { WarningBanner, colors } from '../src/ui';

// Register the platform adapters exactly once, before the first screen
// renders (mirrors setPlatform(nodePlatform()) in the CLI / web GUI / MCP
// server entry points). A failure surfaces as a persistent banner instead of
// a crash: degrade loudly (invariant #6).
const platformError = initMobilePlatform();

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
  return (
    <VaultSessionProvider>
      <LockOnBackground>
        <StatusBar style="light" />
        <WarningBanner
          message={
            platformError
              ? `NorthKeep cannot open vaults on this build: ${platformError}`
              : null
          }
        />
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
          <Stack.Screen name="memory/[id]" options={{ title: 'Memory' }} />
          <Stack.Screen name="converse" options={{ title: 'Converse' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack>
      </LockOnBackground>
    </VaultSessionProvider>
  );
}
