/**
 * The "pick up a project in any local agent" standing instruction (M13),
 * mirroring apps/mobile/src/lib/journal-recipe.ts. Pure TypeScript so the
 * exact user-facing strings are auditable under Node
 * (packages/mcp-server/test/server-tools.test.ts): no em dashes, no steering.
 *
 * The contract is advisory. An agent follows it because the tool descriptions
 * and this instruction say so; nothing forces a session-end handoff.
 */

/** The type this instruction should be stored as, when seeded into the vault. */
export const PROJECT_INSTRUCTION_TYPE = 'procedural' as const;

/**
 * Standing instruction: read at session start, write at session end.
 * Copied verbatim into the vault (or pasted into an AI app) once.
 */
export const PROJECT_STANDING_INSTRUCTION =
  'When I name a project, read it from NorthKeep with project_resume at the start of the session. ' +
  'When a working session on that project ends, call project_wrap with the vault_id, operation_id and ' +
  'expected_revision from that resume, the new Current Status, Next Actions, and the completed work. ' +
  'Call project_checkpoint the same way part-way through a long session. Use ' +
  'project_update for a correction outside a working session. Use project_list to see what is in flight. ' +
  'The live document keeps only its newest log entries; history is available on request, so pass ' +
  'history: true when you need older ones. Keep log entries to a few hundred characters and put detail in its own episodic ' +
  'memory in the project scope. Do not store a separate index memory; the list is the index.';

/**
 * Bootstrap recipe: how a host agent builds a project document from a
 * repository it already has open. Reading order and stop condition are the
 * point, because an unbounded read is how a bootstrap turns into a crawl.
 */
export const PROJECT_BOOTSTRAP_INSTRUCTION =
  'To bootstrap a project from a codebase, read in this order and stop when the sections are full: ' +
  'README, the newest 30 commits of git log, any CHANGELOG, ADR or docs folder, then package or build ' +
  'files for the stack. Fill What & Why from the README\'s own words. Fill Current Status from the newest ' +
  'commits and tags, and date every claim "as of <date>". Fill Next Actions from TODOs, open issues and ' +
  'unfinished branches. Fill Decisions from ADRs and commit messages that explain a choice. Anything you ' +
  'inferred rather than read, mark "unverified". Do not run the code, do not fetch URLs, do not read .env ' +
  'or secret files. Then call project_create with draft: true. Keep the whole document under 6,000 ' +
  'characters; detail goes into episodic memories in the project scope, one per source you read.';

/** Honesty note shown next to the standing instruction. */
export const PROJECT_HONESTY_NOTE =
  'this instruction is advisory. A session that ends abruptly wrote nothing. ' +
  'Cloud and mobile agents see a project only if its scope is Shared, through the generic memory tools.';
