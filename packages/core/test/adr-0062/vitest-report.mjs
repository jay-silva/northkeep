// Reads a `vitest --reporter=verbose` log of the ADR 0062 block (NO_COLOR=1) and prints one line
// per test: pass or fail and, for a failure, the value the test received.
//   node vitest-report.mjs <log> <label>
import fs from 'node:fs';

const [log, label] = process.argv.slice(2);
const status = new Map();
const received = new Map();
let failing = null;
for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
  const row = line.match(/^\s*([✓×]) .*ADR 0062\) > (T\w+):/);
  if (row) status.set(row[2], row[1] === '✓' ? 'passed' : 'failed');
  const fail = line.match(/^\s*FAIL .*> (T\w+):/);
  if (fail) failing = fail[1];
  const assertion = line.match(/AssertionError: expected (\S+) to/);
  if (failing && assertion && !received.has(failing) && assertion[1].startsWith("'")) received.set(failing, assertion[1]);
  const plus = line.match(/^\+ (.*)$/);
  if (failing && plus && !/Received/.test(line)) received.set(failing, `${received.get(failing) ?? ''} ${plus[1].trim()}`.trim());
}
if (status.size === 0) throw new Error(`no ADR 0062 results in ${log}`);
for (const [name, s] of status) console.log(`${label.padEnd(5)} ${s.padEnd(7)} ${name}${received.has(name) ? `  received: ${received.get(name).slice(0, 240)}` : ''}`);
