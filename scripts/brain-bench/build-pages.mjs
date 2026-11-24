// Builds the pages for the "pages" design the way the product would: an agent
// reads the pile of memories and writes one page per person, organization,
// property and pet. It never sees the questions or the answer key, so the
// pages are only as good as an agent can make them from the pile.
//
//   node scripts/brain-bench/build-pages.mjs [--model sonnet]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedHome } from './seed.mjs';
import { runClaude } from './agent.mjs';

export const PAGES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages.generated.json');

const SYSTEM = 'You are a careful records curator. You only restate what the records say. You never add a fact that is not in them.';

const TASK = `Below is every memory in one person's record, as JSON. Each has its text, a type, where it was filed, who saved it ("cli" is the person themselves; "mcp:..." and "connector:..." are AI apps; "import:..." came from an old chat export), the date it was saved, and whether the person confirmed it.

Write one page for each person, organization, property, pet and vehicle that matters in this record, including one for the person the record belongs to. A page holds the facts as they stand now.

Rules:
- A confirmed memory outranks everything else.
- Otherwise a newer fact replaces an older one about the same thing. Say what changed in one short clause, for example "(was X until June 2026)".
- An AI app's session note (type "episodic") is the weakest source. Use it only where nothing else speaks to the point.
- If two records disagree and nothing tells you which is right, do not pick. Write both and say they disagree.
- If a confirmed memory says something is disputed or says to ask the person, copy that instruction onto every page it touches.
- Leave out project status, build notes and anything about how to run software.
- Never invent a fact, a date or a name.

Answer with JSON only, in this shape:
{"pages":[{"name":"Full name","also":["other names it goes by"],"kind":"person|organization|property|pet|vehicle","summary":"one line, under 100 characters","body":"the page, plain sentences or short bullets, under 1200 characters"}]}

The memories:
`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'sonnet';
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-pages-')), 'home');
  const { facts } = await seedHome(home);
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
  console.log(`Asking ${model} to turn ${facts.length} memories into pages...`);
  const run = await runClaude({ prompt: TASK + JSON.stringify(facts), systemPrompt: SYSTEM, model, timeoutMs: 600_000 });
  if (run.error) throw new Error(run.error);
  const json = run.answer.slice(run.answer.indexOf('{'), run.answer.lastIndexOf('}') + 1);
  const { pages } = JSON.parse(json);
  if (!Array.isArray(pages) || pages.some((p) => !p.name || !p.body)) throw new Error('The model did not return pages in the asked shape.');
  fs.writeFileSync(PAGES_FILE, `${JSON.stringify({ built_by: { model, date: new Date().toISOString().slice(0, 10), from_memories: facts.length }, pages }, null, 2)}\n`);
  console.log(`Wrote ${pages.length} pages to ${PAGES_FILE} (cost at list price: $${(run.cost_usd ?? 0).toFixed(2)}).`);
}
