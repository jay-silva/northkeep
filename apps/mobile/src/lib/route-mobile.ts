import { classifyTask, type TaskKind } from '@northkeep/converse/dist/route.js';
import { ON_DEVICE_PROVIDER_ID, type ProviderMeta } from './provider-ids';

/**
 * The phone's model concierge (M12), a deliberately narrower thing than the
 * desktop's (ADR 0011).
 *
 * The problem it solves came out of real use: the on-device model is asked
 * general questions and answers them badly, so the app feels broken. It is not
 * broken — it is being asked to do a job it was never suited for. On a
 * memory-first phone the model's actual work is small: the VAULT does the
 * retrieval (keyword + semantic), and the model only phrases an answer from
 * memories already handed to it. A 3B model on a phone is plausibly fine at
 * that and plainly bad at "explain this contract to me".
 *
 * WHY THIS DOES NOT AUTO-ESCALATE, which is the whole design:
 *
 * ADR 0011's privacy ceiling says auto-routing must NEVER silently move a
 * private turn to a cloud model. On the desktop that protects a Tier-0 local
 * chat. Here it matters more, because "on-device" is the setting a user picks
 * when they mean "nothing about this leaves my phone" — and a router that
 * quietly forwarded the hard questions would break exactly that promise, on
 * exactly the questions most likely to contain something they cared about.
 *
 * So the phone OFFERS and never sends. When a turn looks beyond the local
 * model, the user gets a one-tap choice naming the provider it would go to.
 * That fixes the quality complaint, keeps the promise, and teaches what the
 * on-device model is actually for.
 */

/** Tasks the on-device model can plausibly do on a memory-first phone. */
const LOCAL_TASKS: ReadonlySet<TaskKind> = new Set<TaskKind>(['quick', 'general']);

export type MobileRouteMode =
  /** Answer here. Either the user chose a cloud provider, or the task is local-suited. */
  | 'send'
  /** Local model would answer badly; offer the named provider, do not send. */
  | 'offer-cloud'
  /** Local model is weak here and there is nothing to offer. Answer, but say so. */
  | 'send-degraded';

export interface MobileRoute {
  mode: MobileRouteMode;
  task: TaskKind;
  /** Provider to offer, when mode is 'offer-cloud'. */
  offer?: ProviderMeta;
  /** One plain sentence for the user. Never blank. */
  reason: string;
}

export interface MobileRouteArgs {
  message: string;
  /** The provider the user currently has selected. */
  selectedId: string | null;
  /** Configured providers, on-device excluded or not — it is filtered here. */
  providers: ProviderMeta[];
  /** Ids with a usable credential. A provider we cannot authenticate is not an offer. */
  usableIds: ReadonlySet<string>;
}

const TASK_LABEL: Record<TaskKind, string> = {
  code: 'a coding question',
  reasoning: 'a reasoning question',
  creative: 'a writing task',
  'long-context': 'a long or summarizing task',
  quick: 'a quick question',
  general: 'a general question',
};

export function decideMobileRoute(args: MobileRouteArgs): MobileRoute {
  const task = classifyTask(args.message);

  // The user picked a cloud provider: they have already accepted that this
  // conversation leaves the phone, so there is nothing to decide and nothing
  // to ask. Routing DOWN to the local model would be the mirror-image
  // surprise of the desktop complaint ("why did the weak model answer?").
  if (args.selectedId !== null && args.selectedId !== ON_DEVICE_PROVIDER_ID) {
    return { mode: 'send', task, reason: '' };
  }

  if (LOCAL_TASKS.has(task)) {
    return { mode: 'send', task, reason: '' };
  }

  // Beyond the local model. Find something to offer: a configured provider
  // that is not on-device and that we can actually authenticate.
  const offer = args.providers.find(
    (p) => p.id !== ON_DEVICE_PROVIDER_ID && args.usableIds.has(p.id),
  );
  if (offer === undefined) {
    return {
      mode: 'send-degraded',
      task,
      reason:
        `This looks like ${TASK_LABEL[task]}. The on-device model is best at recalling your ` +
        'memories, so the answer may be thin. Connect a model in Providers for questions like this.',
    };
  }
  return {
    mode: 'offer-cloud',
    task,
    offer,
    reason:
      `This looks like ${TASK_LABEL[task]}, which the on-device model handles poorly. ` +
      `Send it to ${offer.label} instead? Your message would be masked first, and it would ` +
      'leave your phone.',
  };
}

/**
 * Honest copy for the on-device option (the other half of the fix).
 *
 * The picker said "On-device (private)", which reads as a capability claim and
 * invites the general questions it cannot answer. Naming the job it IS good at
 * sets the expectation before the disappointment.
 */
export const ON_DEVICE_LABEL = 'On-device (private)';
export const ON_DEVICE_BLURB =
  'Runs entirely on this iPhone, so nothing leaves it. Best for recalling and adding memories; ' +
  'weak at reasoning, code and long documents.';
