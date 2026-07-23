/**
 * The "let your AI apps keep a journal" recipe (Phase B WS3), lifted from the
 * published northkeep.ai/start guide (step 9) with only phone-UI adaptation.
 * Pure TypeScript with NO React Native, Expo, or runtime @northkeep imports so
 * the exact user-facing strings are auditable under Node
 * (apps/mobile/test/connect-flow.test.ts): no em dashes, no steering.
 *
 * ORDER IS LOAD-BEARING: memory_remember on the connector is FAIL-CLOSED to
 * scopes that already have at least one shared row. That is WHY step 1 seeds a
 * memory into the `conversations` scope BEFORE step 2 shares it; an empty
 * shared scope would reject the AI app's first journal write. The UI must keep
 * seed-then-share in that order.
 */

/** The scope the whole recipe hangs off. */
export const CONVERSATIONS_SCOPE = 'conversations';

/** Step 1's one-tap seed memory (creates the scope so sharing has a row to push). */
export const JOURNAL_SEED_MEMORY = {
  content: 'This scope holds automatic chat summaries from my AI apps.',
  type: 'semantic',
  scope: CONVERSATIONS_SCOPE,
} as const;

/**
 * Pattern 1: a nightly scheduled task, for apps whose tasks can see session
 * history (Manus, ChatGPT). Copied verbatim into the AI app.
 */
export const JOURNAL_PATTERN_SCHEDULED_TASK =
  'Review my conversations from today. For each substantive one, write a two or three ' +
  'sentence summary. Store each summary in NorthKeep using memory_remember with type ' +
  '"episodic" and scope "conversations". Skip small talk and anything already stored.';

/**
 * Pattern 2: a standing instruction stored in the vault itself, so it travels
 * to every paired app. Copied verbatim into the AI app once.
 */
export const JOURNAL_PATTERN_STANDING_INSTRUCTION =
  'Store this in NorthKeep as a procedural memory in scope "conversations": At the end of ' +
  'each substantive conversation, write a concise summary of it to NorthKeep as one episodic ' +
  'memory in scope "conversations". Do this when the conversation is winding down, or ' +
  'whenever I say "log this".';

/** Honesty note, verbatim from the published guide. */
export const JOURNAL_HONESTY_NOTE =
  'these summaries live in a shared scope, so they sit on the connector encrypted at rest ' +
  'until they sync into your vault. After a Sync you can unshare the scope any time; the ' +
  'server copies delete and your vault keeps everything.';

/** True when the vault already has the conversations scope (hides the setup card). */
export function hasConversationsScope(entries: ReadonlyArray<{ scope: string }>): boolean {
  return entries.some((e) => e.scope === CONVERSATIONS_SCOPE);
}
