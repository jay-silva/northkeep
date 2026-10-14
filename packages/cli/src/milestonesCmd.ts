import crypto from 'node:crypto';
import {
  MILESTONES_MALFORMED_MESSAGE,
  ProjectHandoffError,
  getProjectView,
  summarizeMilestones,
  type Milestone,
  type MilestonePlan,
} from '@northkeep/core';
import { confirmPassInDocument } from '@northkeep/core/project-milestones-owner';
import type { WithVault } from './shareCmd.js';

/** `northkeep projects milestones <slug>` (ADR 0065): the plan as text. Read only. */
export async function projectsMilestonesCmd(
  slug: string,
  withVault: WithVault,
  fail: (m: string) => never,
  out: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  type Outcome = { error: string } | { error?: undefined; plan: MilestonePlan };
  const outcome: Outcome = await withVault((vault): Outcome => {
    try {
      return { plan: getProjectView(vault, slug).milestones };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  if (outcome.error !== undefined) fail(outcome.error);
  for (const line of milestoneLines(slug, outcome.plan)) out(line);
}

export function milestoneLines(slug: string, plan: MilestonePlan): string[] {
  switch (plan.kind) {
    case 'absent':
      return [`Project ${slug} has no milestones yet.`];
    case 'none':
      return [`Project ${slug} has no milestones: ${plan.reason}`];
    case 'malformed':
      return [`Project ${slug}: ${MILESTONES_MALFORMED_MESSAGE}`, `Reason: ${plan.reason}`];
    case 'plan': {
      const summary = summarizeMilestones(plan)!;
      const lines = [`Project ${slug}: ${summary.passed} of ${summary.total} milestones passed.`];
      for (const item of plan.items) lines.push(...itemLines(slug, item, summary.current?.id === item.id));
      return lines;
    }
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
}

function itemLines(slug: string, item: Milestone, current: boolean): string[] {
  if (item.state === 'open') return [`  [ ] ${item.id} ${item.title}${current ? '  (current)' : ''}`, `      test: ${item.test}`];
  if (item.by === 'you') return [`  [x] ${item.id} ${item.title}  (passed ${item.on}, confirmed by you)`, `      test: ${item.test}`];
  return [
    `  [x] ${item.id} ${item.title}  (an AI app reported it passed on ${item.on}; not confirmed by you)`,
    `      test: ${item.test}`,
    `      To confirm: northkeep projects pass ${slug} ${item.id}`,
  ];
}

export interface PassDeps {
  withVault: WithVault;
  fail: (m: string) => never;
  /** True only when stdin is a terminal. There is deliberately no flag or environment variable that skips the question. */
  isTTY: () => boolean;
  /** Asks one question on the terminal. */
  ask: (question: string) => Promise<string>;
  now?: () => Date;
  out?: (line: string) => void;
}

/**
 * `northkeep projects pass <slug> <id>` (ADR 0065 Decision 3): the user
 * confirms a milestone after typing yes. The write is pinned to the revision
 * shown, so a change made while the question was open refuses the confirm.
 */
export async function projectsPassCmd(slug: string, id: string, deps: PassDeps): Promise<void> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  if (!deps.isTTY()) deps.fail('This command asks you to type yes, so it runs only in a terminal you are typing in. Nothing was changed.');

  type Seen = { error: string } | { error?: undefined; revision: string; content: string; title: string; test: string };
  const seen: Seen = await deps.withVault((vault): Seen => {
    try {
      const view = getProjectView(vault, slug);
      const { passed } = confirmPassInDocument(view.content, id, now().toISOString());
      return { revision: view.revision, content: view.content, title: passed.title, test: passed.test };
    } catch (err) {
      return { error: `${err instanceof Error ? err.message : String(err)} Nothing was changed.` };
    }
  });
  if (seen.error !== undefined) deps.fail(seen.error);

  out(`Confirm that ${id} ${seen.title} in project ${slug} passed its test:`);
  out(`  ${seen.test}`);
  const answer = await deps.ask('Type yes to confirm: ');
  if (answer.trim() !== 'yes') deps.fail('Not confirmed. Nothing was changed.');

  type Saved = { error: string } | { error?: undefined; revision: string; on: string };
  const saved: Saved = await deps.withVault((vault): Saved => {
    try {
      const { content, passed } = confirmPassInDocument(seen.content, id, now().toISOString());
      const view = vault.replaceProjectContent({
        project: slug,
        expected_revision: seen.revision,
        content,
        source: 'northkeep:milestone-confirm',
        writer: { host: 'northkeep-cli', session_id: crypto.randomUUID() },
      }, { actor: 'owner' });
      vault.save();
      return { revision: view.revision, on: passed.on };
    } catch (err) {
      if (err instanceof ProjectHandoffError && err.code === 'stale_project') {
        return { error: `Project ${slug} changed while you were answering. Nothing was changed. Run the command again to see the current milestones.` };
      }
      return { error: `${err instanceof Error ? err.message : String(err)} Nothing was changed.` };
    }
  });
  if (saved.error !== undefined) deps.fail(saved.error);
  out(`✓ Confirmed ${id} ${seen.title} passed on ${saved.on}. Project ${slug} is now at revision ${saved.revision.slice(0, 8)}.`);
}
