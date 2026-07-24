import type { RememberInput } from '@northkeep/core';

/**
 * Synthetic seed data for the "Try a demo" vault (M6-2b). Everything here is
 * invented for illustration — there are NO real secrets, credentials, names,
 * or personal data. It exists so a curious visitor (and an App Store reviewer
 * with no Mac and no device secret) can see what a populated NorthKeep vault
 * feels like without any setup.
 *
 * The demo vault built from these entries lives in the cache directory under an
 * ephemeral device secret that is never persisted (see paths.ts / vault-session
 * startDemo), so it can never become the user's real vault and never syncs.
 */

/**
 * Fixed passphrase for the demo vault. This is deliberately NOT a secret: the
 * demo vault holds only the synthetic content below, is opened automatically
 * with no passphrase prompt, and its device secret is ephemeral and never
 * stored. Combined, neither half of the two-secret key is retained, so the demo
 * .nkv is unreadable after the session ends even though the passphrase is known.
 */
export const DEMO_PASSPHRASE = 'northkeep-demo-vault';

/** Newest-looking last, so list().reverse() surfaces a sensible order. */
export const DEMO_MEMORIES: RememberInput[] = [
  {
    content:
      'I prefer plain language over jargon. When something is uncertain, say so directly instead of hedging.',
    type: 'identity',
    scope: 'personal',
    source: 'demo',
    confidence: 1.0,
  },
  {
    content:
      'My AI memory should stay private by default. Nothing leaves my device unless I explicitly share a scope.',
    type: 'semantic',
    scope: 'personal',
    source: 'demo',
    confidence: 1.0,
  },
  {
    content:
      'To brew my usual pour-over: 22 g of coffee, 360 g of water at about 96 C, poured in three stages over roughly three minutes.',
    type: 'procedural',
    scope: 'personal',
    source: 'demo',
    confidence: 0.9,
  },
  {
    content:
      'Working on a side project called Lantern, a note-taking app. Current focus is the offline sync layer.',
    type: 'working',
    scope: 'work',
    source: 'demo',
    confidence: 0.8,
  },
  {
    content:
      'Read "The Left Hand of Darkness" last month and loved it. Looking for more character-driven science fiction next.',
    type: 'episodic',
    scope: 'personal',
    source: 'demo',
    confidence: 1.0,
  },
  {
    content:
      'Prefer TypeScript for new projects, and lean toward small, well-audited dependencies over large frameworks.',
    type: 'semantic',
    scope: 'work',
    source: 'demo',
    confidence: 0.95,
  },
  {
    content:
      'Met Dana at the local trail cleanup in April; they run the weekend hiking group and know the coastal routes well.',
    type: 'episodic',
    scope: 'personal',
    source: 'demo',
    confidence: 0.85,
  },
];
