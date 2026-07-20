/**
 * Timed clipboard hygiene for the recovery secret (backup-secret.tsx).
 *
 * The recovery secret is the one thing we copy that must not sit on the
 * clipboard indefinitely: paired with the passphrase it opens the vault. About
 * a minute after a successful copy, the screen clears the clipboard, but ONLY
 * if it still holds the secret. If the user copied anything else since, we
 * must never clobber it. This module is the pure decision logic; the timer,
 * AppState, and expo-clipboard wiring stay in the screen (per the lib
 * convention: no Expo imports here).
 *
 * Scope: recovery secret ONLY. Pairing codes, connector URLs, share ids, and
 * journal prompts are not secrets of this class and are not timed-cleared.
 *
 * KNOWN LIMIT (kept out of the UI copy on purpose): clearing this phone's
 * clipboard cannot recall what iOS Universal Clipboard may already have
 * offered to the user's other Apple devices.
 */

/** How long a copied secret may sit on the clipboard before we clear it. */
export const SECRET_CLIPBOARD_CLEAR_MS = 60_000;

/**
 * Decide whether to overwrite the clipboard, given what it currently holds
 * and the secret we put there. True ONLY when the clipboard still holds
 * exactly the copied secret; anything else (the user copied something new,
 * an empty clipboard, or no secret was copied) must be left alone.
 */
export function shouldClearClipboard(
  current: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof current !== 'string' || current.length === 0) return false;
  return current === secret;
}

/**
 * Whether the clear deadline has passed for a copy made at `copiedAtMs`.
 * Used by the screen when the app is backgrounded or returns to the
 * foreground: the JS timer is suspended while backgrounded, so the screen
 * re-checks the deadline on those transitions instead of trusting the timer.
 * (An immediate clear on background would break the whole feature: switching
 * to the password manager to paste IS a background transition.)
 */
export function secretClearDue(copiedAtMs: number, nowMs: number): boolean {
  return nowMs - copiedAtMs >= SECRET_CLIPBOARD_CLEAR_MS;
}
