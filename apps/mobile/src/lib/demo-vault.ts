import {
  PROJECT_PROVENANCE_METADATA_KEY,
  applyProjectUpdate,
  projectScope,
  type RememberInput,
} from '@northkeep/core';

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

export const DEMO_PROJECT_SLUG = 'lantern-demo';

/**
 * Written through core's own project writer with fixed dates, so the demo
 * project parses exactly like a document an AI app saved on a Mac.
 */
function demoProjectContent(): string {
  const first = applyProjectUpdate(
    '',
    {
      project: DEMO_PROJECT_SLUG,
      expected_revision: null,
      title: 'Lantern (demo project)',
      what_why:
        'Lantern is a made-up note-taking app used to show how NorthKeep keeps a project. Nothing here is real.',
      status: 'Offline sync works on one device. Next up: merging edits made on two devices.',
      next_actions:
        '- Write a test for two devices editing the same note\n- Pick a merge rule for conflicting titles\n- Try the build on an older phone',
      open_questions: '- Should deleted notes stay in the trash for 30 days or 7?',
      files: [
        {
          type: 'url',
          label: 'Sync design notes (example)',
          locator: 'https://example.com/lantern/sync-notes',
          access: 'unverified',
        },
      ],
      decision: 'Store notes as plain Markdown files so they stay readable without the app.',
      log_entry: 'Started the project and wrote down the goal.',
    },
    new Date('2026-09-20T15:00:00.000Z'),
  ).content;
  return applyProjectUpdate(
    first,
    {
      project: DEMO_PROJECT_SLUG,
      expected_revision: 'demo',
      decision: 'Sync only when the phone is on Wi-Fi, to save data.',
      log_entry: 'Offline sync working on one device.',
    },
    new Date('2026-09-27T15:00:00.000Z'),
  ).content;
}

/**
 * One synthetic project so the Projects tab has something to show in the demo
 * and in App Store review. The provenance block names an invented app.
 */
export const DEMO_PROJECT: RememberInput = {
  content: demoProjectContent(),
  type: 'working',
  scope: projectScope(DEMO_PROJECT_SLUG),
  source: 'demo',
  confidence: 1.0,
  metadata: {
    [PROJECT_PROVENANCE_METADATA_KEY]: {
      version: 1,
      host: 'Claude (demo)',
      host_version: null,
      model: null,
      session_id: '00000000-0000-4000-8000-000000000000',
      recorded_at: '2026-09-27T15:00:00.000Z',
    },
  },
};

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
  DEMO_PROJECT,
];
