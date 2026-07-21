import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, type } from './ui';
import { MAX_SCALE_TABBAR } from './lib/type-scale';

type Tab = {
  route: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
};

/**
 * The main sections, mirroring the desktop GUI's section nav. Kept in one place
 * so the "which routes show the bar" check and the tabs stay in lock-step.
 */
const TABS: Tab[] = [
  { route: '/memories', label: 'Memories', icon: 'albums-outline', activeIcon: 'albums' },
  { route: '/converse', label: 'Converse', icon: 'chatbubble-ellipses-outline', activeIcon: 'chatbubble-ellipses' },
  { route: '/settings', label: 'Settings', icon: 'settings-outline', activeIcon: 'settings' },
];

function isActive(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(route + '/');
}

/**
 * Persistent bottom section nav — the mobile analog of the desktop app's
 * clickable, stays-highlighted section headers. Rendered once by the root
 * layout; it shows only on the main section routes and hides itself during
 * onboarding / unlock / link and on pushed detail/compose screens, so those
 * flows stay full-bleed. Tapping a section replaces (not pushes) so the back
 * stack never fills up with tab switches.
 */
export function BottomNav() {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const onMain = TABS.some((t) => isActive(pathname, t.route));
  if (!onMain) return null;
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      {TABS.map((t) => {
        const active = isActive(pathname, t.route);
        const tint = active ? colors.accent : colors.muted;
        return (
          <Pressable
            key={t.route}
            style={styles.tab}
            onPress={() => {
              if (!active) router.replace(t.route as never);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={t.label}
          >
            <Ionicons name={active ? t.activeIcon : t.icon} size={23} color={tint} />
            <Text style={[styles.label, { color: tint }]} maxFontSizeMultiplier={MAX_SCALE_TABBAR}>
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    paddingTop: 9,
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  label: { ...type.caption, fontWeight: '600' },
});
