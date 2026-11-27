/**
 * The number on the app icon (ADR 0095 section 8, option A): how many things
 * need a yes, as of the last time NorthKeep ran. Set through a small local
 * native module (modules/app-badge) that calls iOS's own badge API. No
 * notification is ever scheduled or shown, no push service, nothing leaves the
 * phone. iOS ties the badge to the notification permission, so the first time
 * there is something to count the person is asked once.
 *
 * Every call fails soft: on Android, in a build without the module, or when
 * the person said no, the tab's own red count still shows.
 *
 * NEEDS ON-DEVICE VALIDATION: the permission prompt and the badge itself.
 */

interface AppBadgeNative {
  /** Asks once for the badge permission; later calls return the stored answer. */
  requestPermission(): Promise<boolean>;
  setBadge(count: number): Promise<void>;
}

async function native(): Promise<AppBadgeNative | null> {
  try {
    const { requireOptionalNativeModule } = await import('expo');
    return requireOptionalNativeModule<AppBadgeNative>('AppBadge');
  } catch {
    return null;
  }
}

/** Clamped to what a badge can show; zero clears it. */
export function badgeNumber(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.min(999, Math.floor(count))) : 0;
}

export async function setAppBadge(count: number): Promise<void> {
  const n = badgeNumber(count);
  try {
    const badge = await native();
    if (badge === null) return;
    // Ask only when there is something to show: a prompt on an empty list would explain nothing.
    if (n > 0 && !(await badge.requestPermission())) return;
    await badge.setBadge(n);
  } catch {
    // The tab count is the reliable signal; the icon is a convenience.
  }
}
