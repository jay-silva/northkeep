import type { TextStyle } from 'react-native';

/**
 * Semantic Dynamic-Type scale (Wave 1 accessibility polish). Every screen used
 * a hard-coded fontSize (11-44); this replaces the magic numbers with named
 * roles so the scale is consistent and adjustable in one place.
 *
 * WHY PURE / RN-FREE: the role map is plain data (only a type-only TextStyle
 * import, erased at runtime), so it is testable under Node with vitest per the
 * repo convention. ui.tsx re-exports it as `type` and owns the RN hooks.
 *
 * SIZING RULE: each role's fontSize is the NEAREST existing dominant value in
 * the app, so migrating a screen is a 1:1 rename with no visual delta. The one
 * intentional change is raising sub-12 "muted floor" text to 12 (the critique's
 * "raise 11-13px muted floors"). React Native scales these by the user's text
 * size at render (allowFontScaling defaults on); the real fix that pairs with
 * this file is layout tolerance in the components (min-height, wrapping, and the
 * multiplier caps below), not the rename itself.
 */

export const WEIGHTS = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const satisfies Record<string, TextStyle['fontWeight']>;

export type TypeRole =
  | 'largeTitle'
  | 'title'
  | 'headline'
  | 'body'
  | 'callout'
  | 'subhead'
  | 'footnote'
  | 'caption';

/**
 * Role -> {fontSize, lineHeight, fontWeight}. `as const` keeps fontWeight as the
 * literal union RN's TextStyle wants (a plain string would widen and fail tsc
 * when spread into a style). Spread a role into a StyleSheet entry and override
 * color/margins as needed: `note: { ...TYPE_SCALE.footnote, color: colors.muted }`.
 */
export const TYPE_SCALE = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700' },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700' },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '700' },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  subhead: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 19, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
} as const satisfies Record<TypeRole, TextStyle>;

/**
 * maxFontSizeMultiplier caps for DENSE controls whose row/chip geometry cannot
 * absorb an extreme accessibility size without clipping. Body copy is
 * deliberately NOT capped (it should scale freely); apply these only to chips,
 * badges, the sync pill label, and the tab bar.
 */
export const MAX_SCALE_DENSE = 1.5;
export const MAX_SCALE_TABBAR = 1.3;

/** The smallest fontSize any role is allowed to be (accessibility floor). */
export const MIN_TYPE_SIZE = 12;

/**
 * TODO(type-scale, Wave 1 follow-up): screens NOT yet migrated to the scale.
 * ui.tsx, BottomNav, and the highest-traffic screens (onboarding, create-vault,
 * unlock, backup-secret, sync-setup, sharing, journal-setup, memories, converse,
 * converse-audit, settings, providers) were migrated in this wave. Still on
 * hard-coded fontSizes, safe to migrate the same way (spread `...type.ROLE`):
 *   - app/demo.tsx
 *   - app/device-link.tsx
 *   - app/model-eval.tsx        (diagnostics; low traffic)
 *   - app/memory/[id].tsx
 *   - app/memory/new.tsx
 */
