// Asks every question of every design, one new agent session per question,
// grades the answers and writes a one-page report. Fictional data only; each
// session gets its own copy of a throwaway vault.
//
//   node scripts/brain-bench/run.mjs                      all three designs, all questions
//   node scripts/brain-bench/run.mjs --sample 1           one question of each kind
//   node scripts/brain-bench/run.mjs --arms search --only stale,changed
//   node scripts/brain-bench/run.mjs --out <dir>          continue a run that stopped
//
// Options: --model <name> (default sonnet), --concurrency <n> (default 4),
// --search keyword|meaning (default keyword: no local model).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NOTES, QUESTIONS } from './world.mjs';
import { ARMS, INSTRUCTION_BUDGET, extraInstructions } from './designs.mjs';
import { PASSPHRASE, seedHome } from './seed.mjs';
import { runClaude } from './agent.mjs';
import { gradeAnswer, renderReport } from './grade.mjs';
import { PAGES_FILE } from './build-pages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

export function systemPrompt(today = new Date()) {
  const date = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return [
    `You are a personal AI assistant in a chat app. You are talking with your user. Today is ${date}.`,
    '',
    'Notes you saved about this user in earlier chats:',
    ...APP_NOTES.map((line) => `- ${line}`),
  ].join('\n');
}

/** Pick the questions for this run: by kind or id, then the first `sample` of each kind. */
export function pickQuestions({ only, sample }) {
  let picked = QUESTIONS;
  if (only) {
    const wanted = new Set(only.split(','));
    picked = picked.filter((question) => wanted.has(question.cat) || wanted.has(question.id));
  }
  if (sample) {
    const seen = {};
    picked = picked.filter((question) => (seen[question.cat] = (seen[question.cat] ?? 0) + 1) <= sample);
  }
  return picked;
}

async function pool(items, size, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arms = option('arms', ARMS.join(',')).split(',');
  const model = option('model', 'sonnet');
  const search = option('search', 'keyword');
  const concurrency = Number(option('concurrency', '4'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.resolve(option('out', path.join(HERE, 'out', stamp)));
  const questions = pickQuestions({ only: option('only', null), sample: Number(option('sample', '0')) });
  for (const arm of arms) if (!ARMS.includes(arm)) throw new Error(`Unknown design "${arm}". Use: ${ARMS.join(', ')}.`);
  if (arms.includes('pages') && !fs.existsSync(PAGES_FILE)) throw new Error('No pages yet. Run: node scripts/brain-bench/build-pages.mjs');

  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-run-'));
  const template = path.join(work, 'template');
  const seeded = await seedHome(template);
  const { SERVER_INSTRUCTIONS } = await import('../../packages/mcp-server/dist/project-recipe.js');
  const pages = arms.includes('pages') ? JSON.parse(fs.readFileSync(PAGES_FILE, 'utf8')).pages : [];

  const extraFiles = {};
  for (const arm of arms) {
    const extra = extraInstructions(arm, { baseLength: SERVER_INSTRUCTIONS.length, ...seeded, pages });
    const total = SERVER_INSTRUCTIONS.length + (extra ? extra.length + 1 : 0);
    if (total > INSTRUCTION_BUDGET) throw new Error(`The "${arm}" instructions are ${total} characters; the agent would cut them off past ${INSTRUCTION_BUDGET}.`);
    extraFiles[arm] = path.join(out, `instructions-added-${arm}.txt`);
    fs.writeFileSync(extraFiles[arm], extra);
  }

  const prompt = systemPrompt();
  const jobs = arms.flatMap((arm) => questions.map((question) => ({ arm, question })));
  console.log(`${jobs.length} sessions: ${questions.length} questions x ${arms.length} designs, model ${model}, ${search} search. Writing to ${out}`);
  let done = 0;
  await pool(jobs, concurrency, async ({ arm, question }) => {
    const file = path.join(out, arm, `${question.id}.json`);
    if (!fs.existsSync(file)) {
      const home = path.join(work, `${arm}-${question.id}`);
      fs.cpSync(template, home, { recursive: true });
      const env = { NORTHKEEP_HOME: home, NORTHKEEP_PASSPHRASE: PASSPHRASE, NORTHKEEP_NO_KEYCHAIN: '1', BENCH_ARM: arm, BENCH_EXTRA_FILE: extraFiles[arm], BENCH_PAGES_FILE: PAGES_FILE };
      // A closed port: the server falls back to keyword search, as it does with no local model.
      if (search === 'keyword') env.NORTHKEEP_OLLAMA_URL = 'http://127.0.0.1:9';
      const run = await runClaude({
        prompt: question.q, systemPrompt: prompt, model,
        mcpConfig: { mcpServers: { northkeep: { command: process.execPath, args: [path.join(HERE, 'server.mjs')], env } } },
      });
      fs.rmSync(home, { recursive: true, force: true });
      const graded = run.error ? {} : gradeAnswer(question, run.answer);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ id: question.id, cat: question.cat, q: question.q, arm, model, ...run, looked: run.tool_calls.length > 0, ...graded }, null, 2)}\n`);
    }
    done += 1;
    if (done % 10 === 0 || done === jobs.length) console.log(`  ${done} of ${jobs.length}`);
  });
  fs.rmSync(work, { recursive: true, force: true });

  const rows = Object.fromEntries(arms.map((arm) => [arm, questions.map((question) => JSON.parse(fs.readFileSync(path.join(out, arm, `${question.id}.json`), 'utf8')))]));
  const report = renderReport({ model, date: stamp.slice(0, 10), arms: rows });
  fs.writeFileSync(path.join(out, 'report.md'), `${report}\n`);
  console.log(`\n${report}\n\nReport: ${path.join(out, 'report.md')}\nTranscripts: ${out}/<design>/<question>.json`);
}
