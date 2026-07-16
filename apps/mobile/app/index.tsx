import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useVaultSession } from '../src/lib/vault-session';
import { colors } from '../src/ui';

/** Route dispatcher: onboarding for a fresh install, unlock when linked, memories when open. */
export default function Index() {
  const { status } = useVaultSession();
  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (status === 'unlinked') return <Redirect href="/onboarding" />;
  if (status === 'locked') return <Redirect href="/unlock" />;
  return <Redirect href="/memories" />;
}
