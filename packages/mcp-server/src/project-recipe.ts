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
  'When I name a project, read it from NorthKeep with project_get at the start of the session. ' +
  'When a working session on that project ends, call project_update with the new Current Status, ' +
  'Next Actions, and a log entry describing what was done. Use project_list to see what is in flight. ' +
  'Do not store a separate index memory; the list is the index.';

/** Honesty note shown next to the standing instruction. */
export const PROJECT_HONESTY_NOTE =
  'this instruction is advisory. A session that ends abruptly wrote nothing. ' +
  'Cloud and mobile agents see a project only if its scope is Shared, through the generic memory tools.';
