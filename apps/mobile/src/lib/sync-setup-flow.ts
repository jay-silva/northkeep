/**
 * The "turn on sync from this phone" decision flow (Phase A of phone-first
 * onboarding). Pure TypeScript with NO React Native, Expo, or @northkeep
 * imports, unit-tested under Node (apps/mobile/test/sync-setup-flow.test.ts).
 *
 * Sync accounts are IMPLICIT (ADR 0009): accountId and token both derive from
 * the 32-byte device secret, and the server creates storage on the first push.
 * So "enable sync" is exactly: save the server URL, then run the SAME
 * save-then-push sequence every edit already uses (runSyncAfterSave, wired to
 * pushVaultMobile in vault-session.tsx). No registration endpoint, no parallel
 * transport.
 *
 * The URL is saved BEFORE the first push, and stays saved on every failure:
 * a 402 (subscription) or 403 (private beta) means the account is not active
 * YET, and keeping the URL is what makes sync activate automatically on a later
 * push or pull-to-refresh once the account is enabled. A network failure keeps
 * it for the same reason (the retry needs it).
 */

import type { SyncEvent } from './sync-flow';
import {
  PRIVATE_BETA_MESSAGE,
  SUBSCRIPTION_ACTIVATION_HINT,
  SUBSCRIPTION_REQUIRED_MESSAGE,
  classifySyncError,
} from './sync-errors';

/** The production sync server, prefilled on the enable-sync screen. */
export const DEFAULT_SYNC_SERVER_URL = 'https://northkeep-sync-server.vercel.app';

export type EnableSyncOutcome =
  /** The first push landed; the vault is on the server at `version`. */
  | { kind: 'enabled'; version: number; recoveredConflict: boolean }
  /** HTTP 402: neutral activation state (App Store steering: no selling, no links). */
  | { kind: 'subscription-required'; message: string; hint: string }
  /** HTTP 403: the beta allowlist does not include this account yet. */
  | { kind: 'private-beta'; message: string }
  /** Anything else (network, locked-vault conflict, unexpected HTTP). Retryable. */
  | { kind: 'failed'; message: string; retryable: true };

/** The two side effects the flow needs, injected so the sequence tests in Node. */
export interface EnableSyncPorts {
  /** Persist the validated, normalized server URL (SecureStore on the device). */
  saveServerUrl(url: string): Promise<void>;
  /**
   * Run the existing save-then-push sequence against the just-saved server and
   * return its terminal event. May THROW transport errors (402, 403, network);
   * those are classified here. Wired to VaultSession.pushNow().
   */
  runFirstPush(): Promise<SyncEvent>;
}

/**
 * Save the server URL, run the first push, and fold every outcome into one
 * screen-ready result. `normalizedUrl` must already have passed assertSyncUrl
 * (the screen validates before calling; validation stays with @northkeep/sync
 * so the https-or-loopback rule matches desktop exactly).
 */
export async function runEnableSync(
  ports: EnableSyncPorts,
  normalizedUrl: string,
): Promise<EnableSyncOutcome> {
  await ports.saveServerUrl(normalizedUrl);
  let event: SyncEvent;
  try {
    event = await ports.runFirstPush();
  } catch (err) {
    const friendly = classifySyncError(err);
    if (friendly.kind === 'subscription-required') {
      return {
        kind: 'subscription-required',
        message: SUBSCRIPTION_REQUIRED_MESSAGE,
        hint: SUBSCRIPTION_ACTIVATION_HINT,
      };
    }
    if (friendly.kind === 'not-enabled') {
      return { kind: 'private-beta', message: PRIVATE_BETA_MESSAGE };
    }
    return { kind: 'failed', message: friendly.message, retryable: true };
  }
  switch (event.type) {
    case 'synced':
      return { kind: 'enabled', version: event.version, recoveredConflict: false };
    case 'conflict-recovered':
      // The account already had a blob (re-enabling sync) and another device had
      // moved on; last-writer-wins ran and this phone's vault is now live.
      return { kind: 'enabled', version: event.version, recoveredConflict: true };
    case 'error':
      return { kind: 'failed', message: event.message, retryable: true };
    default:
      // 'start' is never a terminal event; treat defensively as a retryable failure.
      return { kind: 'failed', message: 'Sync did not finish. Try again.', retryable: true };
  }
}
