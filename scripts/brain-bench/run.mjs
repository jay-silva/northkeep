// Asks every question of every design, one new agent session per question,
// grades the answers and writes a report. Fictional data only; each session
// gets its own copy of a throwaway vault.
//
//   node scripts/brain-bench/run.mjs                      every design, every question
//   node scripts/brain-bench/run.mjs --sample 1           one question of each kind
//   node scripts/brain-bench/run.mjs --arms search,brief --only stale,changed
//   node scripts/brain-bench/run.mjs --out <dir>          continue a run that stopped
//
// Options: --model <name> (default sonnet), --repeats <n> (default 1),
// --concurrency <n> (default 4), --search keyword|meaning (default keyword:
// no local model), --app chat|coding (default chat), --judge-model <name>
// (default: the same model), --no-judge (text rules only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NOTES, QUESTIONS } from './world.mjs';
import { ARMS, INSTRUCTION_BUDGET, extraInstructions, tidyMemories, usesTidyVault } from './designs.mjs';
import { PASSPHRASE, seedHome } from './seed.mjs';
import { runClaude } from './agent.mjs';
import { gradeAnswer, renderReport } from './grade.mjs';
import { judgeBatch } from './judge.mjs';
import { PAGES_FILE } from './build-pages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JUDGE_BATCH = 20;

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

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arms = option('arms', ARMS.join(',')).split(',');
  const model = option('model', 'sonnet');
  const judgeModel = option('judge-model', model);
  const search = option('search', 'keyword');
  const app = option('app', 'chat');
  const repeats = Number(option('repeats', '1'));
  const concurrency = Number(option('concurrency', '4'));
  const useJudge = !process.argv.includes('--no-judge');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.resolve(option('out', path.join(HERE, 'out', stamp)));
  const questions = pickQuestions({ only: option('only', null), sample: Number(option('sample', '0')) });
  for (const arm of arms) if (!ARMS.includes(arm)) throw new Error(`Unknown design "${arm}". Use: ${ARMS.join(', ')}.`);
  if (!fs.existsSync(PAGES_FILE)) throw new Error('No pages yet. Run: node scripts/brain-bench/build-pages.mjs');
  const { pages } = read(PAGES_FILE);

  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-run-'));
  const now = Date.now();
  const seeded = await seedHome(path.join(work, 'plain'), now);
  if (arms.some(usesTidyVault)) await seedHome(path.join(work, 'tidy'), now, tidyMemories(pages));
  const { SERVER_INSTRUCTIONS } = await import('../../packages/mcp-server/dist/project-recipe.js');

  const extraFiles = {};
  for (const arm of arms) {
    const extra = extraInstructions(arm, { baseLength: SERVER_INSTRUCTIONS.length, ...seeded, pages });
    const total = SERVER_INSTRUCTIONS.length + (extra ? extra.length + 1 : 0);
    if (total > INSTRUCTION_BUDGET) throw new Error(`The "${arm}" instructions are ${total} characters; the agent would cut them off past ${INSTRUCTION_BUDGET}.`);
    extraFiles[arm] = path.join(out, `instructions-added-${arm}.txt`);
    fs.writeFileSync(extraFiles[arm], extra);
  }

  const prompt = systemPrompt();
  const fileFor = (arm, question, repeat) => path.join(out, arm, `${question.id}${repeat > 1 ? `.r${repeat}` : ''}.json`);
  const jobs = arms.flatMap((arm) => questions.flatMap((question) => Array.from({ length: repeats }, (_, i) => ({ arm, question, repeat: i + 1 }))));
  console.log(`${jobs.length} sessions: ${questions.length} questions x ${arms.length} designs x ${repeats}, model ${model}, ${search} search, ${app} app. Writing to ${out}`);
  let done = 0;
  await pool(jobs, concurrency, async ({ arm, question, repeat }) => {
    const file = fileFor(arm, question, repeat);
    if (!fs.existsSync(file)) {
      const home = path.join(work, `${arm}-${question.id}-${repeat}`);
      fs.cpSync(path.join(work, usesTidyVault(arm) ? 'tidy' : 'plain'), home, { recursive: true });
      const env = { NORTHKEEP_HOME: home, NORTHKEEP_PASSPHRASE: PASSPHRASE, NORTHKEEP_NO_KEYCHAIN: '1', BENCH_ARM: arm, BENCH_EXTRA_FILE: extraFiles[arm], BENCH_PAGES_FILE: PAGES_FILE };
      // A closed port: the server falls back to keyword search, as it does with no local model.
      if (search === 'keyword') env.NORTHKEEP_OLLAMA_URL = 'http://127.0.0.1:9';
      const run = await runClaude({
        prompt: question.q, systemPrompt: prompt, model, app,
        mcpConfig: { mcpServers: { northkeep: { command: process.execPath, args: [path.join(HERE, 'server.mjs')], env } } },
      });
      fs.rmSync(home, { recursive: true, force: true });
      const graded = run.error ? {} : gradeAnswer(question, run.answer);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      write(file, {
        id: question.id, cat: question.cat, q: question.q, arm, repeat, model, ...run,
        looked: run.tool_calls.some((call) => call.name.startsWith('mcp__northkeep__')),
        rule_verdict: graded.verdict, stale: graded.stale,
      });
    }
    done += 1;
    if (done % 20 === 0 || done === jobs.length) console.log(`  ${done} of ${jobs.length}`);
  });
  fs.rmSync(work, { recursive: true, force: true });

  if (useJudge) {
    // Mixed across designs, so the second grader cannot tell which design answered.
    const pending = jobs.map((job) => fileFor(job.arm, job.question, job.repeat)).filter((file) => { const row = read(file); return !row.error && !row.judge_verdict; })
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    const batches = Array.from({ length: Math.ceil(pending.length / JUDGE_BATCH) }, (_, i) => pending.slice(i * JUDGE_BATCH, (i + 1) * JUDGE_BATCH));
    const byId = new Map(QUESTIONS.map((question) => [question.id, question]));
    console.log(`Second grader (${judgeModel}): ${pending.length} answers in ${batches.length} batches`);
    await pool(batches, concurrency, async (files) => {
      const rows = files.map(read);
      const result = await judgeBatch(rows, byId, judgeModel);
      if (result.error) console.log(`  a batch was not graded: ${result.error}`);
      files.forEach((file, i) => { if (result.verdicts[i]) write(file, { ...rows[i], judge_verdict: result.verdicts[i] }); });
    });
  }

  // The rules are re-applied on every report, so a corrected answer key reaches old transcripts too.
  const regrade = (question, row) => (row.error ? row : { ...row, ...(({ verdict, stale }) => ({ rule_verdict: verdict, stale }))(gradeAnswer(question, row.answer)) });
  const rows = Object.fromEntries(arms.map((arm) => [arm, jobs.filter((job) => job.arm === arm).map((job) => regrade(job.question, read(fileFor(arm, job.question, job.repeat))))]));
  const report = renderReport({ model, app, search, date: stamp.slice(0, 10), arms: rows });
  fs.writeFileSync(path.join(out, 'report.md'), `${report}\n`);
  console.log(`\n${report}\n\nReport: ${path.join(out, 'report.md')}\nTranscripts: ${out}/<design>/<question>.json`);
}
