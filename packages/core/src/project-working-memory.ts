import { parseProjectSlug } from './project-doc.js';

/**
 * The live project document is one working memory in `project:<slug>`.
 * A second one makes Projects home show that project as a conflict with no title.
 *
 * Kept out of project-doc.ts. The connector server keeps a byte-identical copy
 * of that file, and this rule is about writes on this machine.
 */
export const PROJECT_WORKING_MEMORY_MESSAGE =
  'A working memory in a project collection is the project document. Saving another one makes that project show as a conflict with no title. Change the project from Projects, or save this memory as a different type.';

export class ProjectWorkingMemoryError extends Error {
  constructor(message: string = PROJECT_WORKING_MEMORY_MESSAGE) {
    super(message);
    this.name = 'ProjectWorkingMemoryError';
  }
}

/** The refusal a person should see, or null when this type and scope are fine together. */
export function projectWorkingMemoryMessage(type: string, scope: string): string | null {
  if (type !== 'working') return null;
  return parseProjectSlug(scope.trim()) === null ? null : PROJECT_WORKING_MEMORY_MESSAGE;
}

/**
 * Refuse a write that would newly make a working memory in a valid project scope.
 * A memory that is already the project document can still be edited, including a
 * move from one project scope to another. `before` is null for a brand-new memory.
 */
export function assertNotNewProjectWorkingMemory(
  before: { type: string; scope: string } | null,
  after: { type: string; scope: string },
): void {
  if (projectWorkingMemoryMessage(after.type, after.scope) === null) return;
  if (before !== null && projectWorkingMemoryMessage(before.type, before.scope) !== null) return;
  throw new ProjectWorkingMemoryError();
}
