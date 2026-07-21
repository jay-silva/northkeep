/**
 * Pure de-dupe primitive for VoiceOver announcements (Wave 1 accessibility).
 *
 * The app's signature value is "degrade loudly" (invariant #6), but the degrade
 * banner, sync-failure state, and error notes had zero screen-reader
 * announcements, so they were silent to VoiceOver. The RN AccessibilityInfo call
 * lives in the ui.tsx hook; this module decides WHETHER to speak, so we never
 * spam VoiceOver with an unchanged value (e.g. a banner re-rendering for an
 * unrelated reason). Pure and RN-free, tested under Node.
 *
 * IMPORTANT (iOS): accessibilityLiveRegion is Android-only. On iOS the thing
 * that actually speaks is AccessibilityInfo.announceForAccessibility, which the
 * hook calls with whatever this function returns.
 */

/** Trim to a stable comparison form; nullish/whitespace becomes ''. */
function normalize(s: string | null | undefined): string {
  return (s ?? '').trim();
}

/**
 * Given the previously-announced text and the incoming text, return the text to
 * announce now, or null to stay silent. Announces when the value is non-empty
 * AND different from what was last announced. An empty/cleared value announces
 * nothing (and the caller should record '' as prev, so the SAME message can
 * announce again later if it returns).
 */
export function announcementFor(
  prev: string | null | undefined,
  next: string | null | undefined,
): string | null {
  const n = normalize(next);
  if (n === '') return null;
  if (n === normalize(prev)) return null;
  return n;
}
