// The three designs under test. "search" is NorthKeep as shipped. "brief" and
// "pages" are prototypes that live only in this bench: they add text to the
// connect-time instructions and, for pages, two read-only tools.

export const ARMS = ['search', 'brief', 'pages'];

/**
 * Claude Code cut a test server's instructions off a little past 4,000
 * characters (measured 2026-11-23), so every design has to fit under this.
 */
export const INSTRUCTION_BUDGET = 4000;

const PAGES_RULE =
  'NorthKeep also keeps one page for each person, organization, property and pet in this user\'s life, kept current. ' +
  'When a question is about one of them, read its page with page_get before you answer, and trust it over older notes. ' +
  'page_list shows every page.';

/** The lines a brief would hold, most important first: confirmed facts, then project names. */
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
 * The text a design adds after NorthKeep's own instructions. Lines that would
 * push the total past the budget are dropped from the end, never cut mid-line.
 */
export function extraInstructions(arm, { baseLength, facts, projects, pages }) {
  if (arm === 'search') return '';
  const head = arm === 'pages' ? [`${PAGES_RULE} Pages: ${pages.map((p) => p.name).join('; ')}.`] : [];
  const lines = [...head];
  let length = baseLength + 1 + head.join('\n').length;
  for (const line of briefLines(facts, projects)) {
    if (length + line.length + 1 > INSTRUCTION_BUDGET) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

/** Find a page by its name or one of its other names, ignoring case. */
export function findPage(pages, name) {
  const wanted = String(name).trim().toLowerCase();
  return pages.find((page) => [page.name, ...(page.also ?? [])].some((n) => n.toLowerCase() === wanted))
    ?? pages.find((page) => page.name.toLowerCase().includes(wanted) || wanted.includes(page.name.toLowerCase()))
    ?? null;
}
