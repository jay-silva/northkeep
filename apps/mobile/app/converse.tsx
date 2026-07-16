import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../src/ui';

/**
 * Converse placeholder. The chat pipeline (BYOK providers, Tier-1 redaction
 * firewall, streaming over expo/fetch, the outbound audit view) is milestone
 * M6-3 and is deliberately NOT built here.
 */
export default function Converse() {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Converse is coming in M6-3</Text>
      <Text style={styles.body}>
        Chat with your vault using your own model keys, behind the on-device redaction firewall.
        Until then, Converse is available in NorthKeep on your Mac.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
  body: { color: colors.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' },
});
