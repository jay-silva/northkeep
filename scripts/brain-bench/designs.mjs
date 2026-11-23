// The designs under test, as a ladder: each one adds exactly one thing to the
// one before, so a change in score has one cause. "search" is NorthKeep as
// shipped. The rest are prototypes that live only in this bench.

export const ARMS = ['search', 'brief', 'nudge', 'tidy', 'pages', 'pages-index'];

/** What each design adds to the one before it, for the report. */
export const ADDS = {
  search: 'NorthKeep as shipped',
  brief: 'the confirmed facts, pushed at connect',
  nudge: 'a firmer "look it up first" sentence',
  tidy: 'a one-time cleanup, searched the usual way',
  pages: 'the same cleanup as pages, read by name',
  'pages-index': 'the list of page names, pushed at connect',
};

/**
 * Claude Code cut a test server's instructions off a little past 4,000
 * characters (measured 2026-11-23), so every design has to fit under this.
 */
export const INSTRUCTION_BUDGET = 4000;

const LOOK_FIRST =
  'Before you answer any question about this user\'s life or work, look it up in NorthKeep first, even when your own notes seem to answer it. ' +
  'Your notes may be out of date; NorthKeep is kept current.';

const PAGES_RULE =
  'NorthKeep also keeps one page for each person, organization, property and pet in this user\'s life, kept current. ' +
  'When a question is about one of them, read its page with page_get, and trust it over older notes. page_list shows every page.';

/** True for the designs that serve pages through page_list and page_get. */
export const servesPages = (arm) => arm === 'pages' || arm === 'pages-index';
/** True for the design whose vault also holds the cleaned-up facts as ordinary memories. */
export const usesTidyVault = (arm) => arm === 'tidy';

/** The lines a brief holds, most important first: confirmed facts, then project names. */
function briefLines(facts, projects) {
  const order = { identity: 0, semantic: 1, procedural: 2, episodic: 3 };
  const confirmed = facts.filter((fact) => fact.confirmed).sort((a, b) => order[a.type] - order[b.type]);
  return [
    'What this user has confirmed about themselves:',
    ...confirmed.map((fact) => `- ${fact.content}`),
    `Projects (read one with project_get): ${projects.map((p) => p.slug).join(', ')}.`,
  ];
}

/**
 * The text a design adds after NorthKeep's own instructions. Brief lines that
 * would push the total past the budget are dropped from the end, never cut
 * mid-line.
 */
export function extraInstructions(arm, { baseLength, facts, projects, pages }) {
  if (arm === 'search') return '';
  const head = [];
  if (arm !== 'brief') head.push(LOOK_FIRST);
  if (servesPages(arm)) head.push(PAGES_RULE);
  if (arm === 'pages-index') head.push(`Pages: ${pages.map((p) => p.name).join('; ')}.`);
  const lines = [...head];
  let length = baseLength + head.reduce((sum, line) => sum + line.length + 1, 0);
  for (const line of briefLines(facts, projects)) {
    if (length + line.length + 1 > INSTRUCTION_BUDGET) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

/** The cleaned-up facts as ordinary memories: one per line of each page, led by the page name. */
export function tidyMemories(pages) {
  return pages.flatMap((page) => page.body.split('\n')
    .map((line) => line.replace(/^[-*\s]+/, '').trim())
    .filter(Boolean)
    .map((line) => `${page.name}: ${line}`));
}

/** Find a page by its name or one of its other names, ignoring case. */
export function findPage(pages, name) {
  const wanted = String(name).trim().toLowerCase();
  return pages.find((page) => [page.name, ...(page.also ?? [])].some((n) => n.toLowerCase() === wanted))
    ?? pages.find((page) => page.name.toLowerCase().includes(wanted) || wanted.includes(page.name.toLowerCase()))
    ?? null;
}
