/**
 * User-facing sync error mapping (Phase A of phone-first onboarding, WS4).
 * Pure TypeScript with NO React Native, Expo, or @northkeep imports, so it is
 * unit-tested under Node (apps/mobile/test/sync-errors.test.ts).
 *
 * WHY THIS EXISTS: the shared @northkeep/sync transport throws
 * SubscriptionRequiredError on HTTP 402, and that error's MESSAGE is written
 * for the desktop CLI ("... Run 'northkeep sync subscribe'.", with a price).
 * On mobile that copy must never reach the user: App Store steering rules
 * forbid the app from selling, linking to a purchase, or naming a price or
 * website for purchasing. Every screen that surfaces a sync failure routes the
 * raw error through classifySyncError() so the CLI string is replaced with the
 * neutral activation copy below.
 *
 * Detection is by error NAME and message shape rather than instanceof, so this
 * module stays import-free and testable, and so a 402 survives any re-wrapping
 * that loses the prototype chain.
 */

/** Machine-readable category for a sync failure (drives distinct UI states). */
export type SyncErrorKind = 'subscription-required' | 'not-enabled' | 'network' | 'other';

export interface UserFacingSyncError {
  kind: SyncErrorKind;
  /** Safe to show verbatim. Never contains the server's CLI-flavored copy. */
  message: string;
}

/** Neutral subscription copy: states the requirement, sells nothing, links nowhere. */
export const SUBSCRIPTION_REQUIRED_MESSAGE = 'Sync requires a NorthKeep subscription.';

/** Activation guidance shown with the message above. No link, no price, no purchase verb. */
export const SUBSCRIPTION_ACTIVATION_HINT =
  'Already subscribed? Sync activates automatically once your subscription is active. Pull to refresh to re-check.';

/** HTTP 403 from the sync server: the account is not on the private-beta allowlist. */
export const PRIVATE_BETA_MESSAGE =
  "This sync server is in private beta. Your account isn't enabled yet.";

/** Transport-level failure (offline, DNS, timeout). Always retryable. */
export const NETWORK_FAILURE_MESSAGE =
  'Could not reach the sync server. Check your connection and try again.';

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * True for the shared transport's 402 error in every form it can arrive:
 * by name (SubscriptionRequiredError), by its CLI message (in case a wrapper
 * re-threw it as a plain Error), or by a raw "HTTP 402" transport message.
 */
function isSubscriptionRequired(err: unknown): boolean {
  if (err instanceof Error && err.name === 'SubscriptionRequiredError') return true;
  const msg = messageOf(err);
  if (/northkeep sync subscribe/i.test(msg)) return true;
  if (/\$\s*\d+.*subscription/i.test(msg)) return true;
  return /\bHTTP 402\b/.test(msg);
}

/**
 * Map any error thrown by the sync paths (push, pull, first push during
 * enable-sync) to copy that is safe to show a mobile user. Non-sync errors
 * pass through with their original message; the messages written in
 * src/lib/sync.ts are already user-facing.
 */
export function classifySyncError(err: unknown): UserFacingSyncError {
  if (isSubscriptionRequired(err)) {
    return {
      kind: 'subscription-required',
      message: `${SUBSCRIPTION_REQUIRED_MESSAGE} ${SUBSCRIPTION_ACTIVATION_HINT}`,
    };
  }
  const msg = messageOf(err);
  if (/\bHTTP 403\b/.test(msg)) {
    return { kind: 'not-enabled', message: PRIVATE_BETA_MESSAGE };
  }
  if (
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) ||
    err instanceof TypeError ||
    /network request failed|failed to fetch|network error/i.test(msg)
  ) {
    return { kind: 'network', message: NETWORK_FAILURE_MESSAGE };
  }
  return { kind: 'other', message: msg };
}

/** Convenience for catch blocks that only need the display string. */
export function userFacingSyncError(err: unknown): string {
  return classifySyncError(err).message;
}
