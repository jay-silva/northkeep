import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard for a bug that shipped, was fixed in ONE place, and then bit
 * us again somewhere else.
 *
 * On Hermes (the React Native engine) the Buffer polyfill's `subarray()` returns
 * a plain Uint8Array rather than a Buffer, because it does not honour
 * Symbol.species. A plain Uint8Array has no `.equals`, so `buf.subarray(a, b)
 * .equals(other)` throws `TypeError: ... .equals is not a function` on device
 * while passing every Node test — V8 DOES honour Symbol.species, so this class
 * of bug is structurally invisible to the rest of this suite.
 *
 * It was fixed in packages/core/src/vault.ts (Buffer.compare) but missed in
 * apps/mobile/src/lib/sync.ts, where it threw inside the local-vault check that
 * runs BEFORE the first socket. The mobile error classifier then reported it as
 * "Could not reach the sync server", so a code bug presented as bad wifi and
 * sync was dead on the phone.
 *
 * A behavioural test cannot catch this under Node, so this scans the source
 * instead. Use `Buffer.compare(a, b) === 0`, which accepts a Uint8Array and is
 * identical on both engines.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/** Source trees that can execute on a phone, plus the ones they mirror. */
const SCANNED = [
  'apps/mobile/src',
  'packages/sync/src',
  'packages/core/src',
  'packages/platform-mobile/src',
];

/**
 * Buffer-only methods. A plain Uint8Array has none of them, so calling any one
 * on the result of subarray()/slice() is the same trap as `.equals`.
 */
const BUFFER_ONLY = String.raw`equals|compare|copy|toString|write|swap16|swap32|swap64|indexOf|lastIndexOf|includes|read[A-Z]\w*|write[A-Z]\w*`;
const FORBIDDEN = new RegExp(String.raw`\.(?:subarray|slice)\s*\([^)]*\)\s*\.(?:${BUFFER_ONLY})\s*\(`);

/**
 * Prettier will split a long expression across lines, which hides the pattern
 * from a line-by-line scan. Collapse whitespace before matching, then map the
 * match back to a line number for the failure message.
 */
function findOffenders(text: string): number[] {
  // Build an index from collapsed-offset → original line, so a match in the
  // normalized text still reports where a human should look.
  const lineOf: number[] = [];
  let collapsed = '';
  let line = 1;
  let lastWasSpace = false;
  for (const ch of text) {
    if (ch === '\n') line += 1;
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      lastWasSpace = true;
      collapsed += ' ';
      lineOf.push(line);
      continue;
    }
    lastWasSpace = false;
    collapsed += ch;
    lineOf.push(line);
  }
  const hits: number[] = [];
  const re = new RegExp(FORBIDDEN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(collapsed)) !== null) hits.push(lineOf[m.index] ?? 0);
  return hits;
}

function sourceFiles(dir: string): string[] {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('Hermes Buffer guard', () => {
  it('finds files to scan (the guard itself must not silently pass)', () => {
    const files = SCANNED.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(20);
  });

  it('no device-reachable source calls a Buffer-only method on subarray()/slice()', () => {
    const offenders: string[] = [];
    for (const rel of SCANNED.flatMap(sourceFiles)) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const line of findOffenders(text)) offenders.push(`${rel}:${line}`);
    }
    expect(
      offenders,
      `.subarray()/.slice() return a plain Uint8Array on Hermes, which has no Buffer methods.\n` +
        `Re-wrap with Buffer.from(...), or use the static Buffer.compare(a, b) === 0:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // The guard is only worth having if it survives reformatting and aliasing.
  // These are the shapes a future edit is most likely to arrive in.
  it('catches the shapes a line-by-line scan would miss', () => {
    const shouldCatch = [
      `blob.subarray(0, 4).equals(MAGIC)`,
      `blob.subarray(0, MAGIC.length).equals(MAGIC)`,
      // prettier splitting a long expression across lines
      `const ok =\n  blob\n    .subarray(0, 4)\n    .equals(Buffer.from(NKV_MAGIC, 'ascii'));`,
      `blob.slice(0, 4).equals(MAGIC)`,
      `header.subarray(52, 56).readUInt32BE(0)`,
      `body.subarray(0, n).toString('hex')`,
      `buf.slice(4).indexOf(0x4e)`,
    ];
    for (const src of shouldCatch) {
      expect(findOffenders(src), `should have been caught: ${JSON.stringify(src)}`).not.toEqual([]);
    }

    const shouldNotCatch = [
      `Buffer.compare(blob.subarray(0, 4), MAGIC) === 0`,
      `Buffer.from(blob.subarray(0, 4)).equals(MAGIC)`,
      `blob.subarray(0, 4)`,
      `list.slice(0, 4).map((x) => x.id)`, // Array.slice, not Buffer
    ];
    for (const src of shouldNotCatch) {
      expect(findOffenders(src), `false positive on: ${JSON.stringify(src)}`).toEqual([]);
    }
  });

  it('Buffer.compare is a correct substitute when subarray yields a bare Uint8Array', () => {
    const magic = Buffer.from('NKV1', 'ascii');
    const blob = Buffer.concat([magic, Buffer.alloc(48)]);
    // Simulate Hermes: hand Buffer.compare exactly what a species-less subarray
    // would produce — a plain Uint8Array over the same bytes.
    const hermesSlice = new Uint8Array(blob.buffer, blob.byteOffset, 4);
    expect(typeof (hermesSlice as unknown as Buffer).equals).toBe('undefined');
    expect(Buffer.compare(hermesSlice, magic)).toBe(0);
    expect(Buffer.compare(new Uint8Array([0, 0, 0, 0]), magic)).not.toBe(0);
  });
});
