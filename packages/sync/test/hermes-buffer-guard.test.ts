import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard for a bug that shipped, was fixed in ONE place, and then bit
 * us again somewhere else.
 *
 * The mechanism, measured rather than assumed (buffer@6.0.3 is what the phone
 * resolves): the polyfill overrides `Buffer.prototype.slice` but never defines
 * `subarray`, so `subarray` is inherited from `Uint8Array.prototype`, and it
 * defines no `Symbol.species` either. Under V8 the inherited `subarray` runs
 * SpeciesConstructor, finds no species, falls back to the object's constructor,
 * and hands back a Buffer — verified: the POLYFILL's `subarray(0,4)` under Node
 * still has `.equals`. Hermes does not apply that lookup and returns a base
 * Uint8Array, which has no `.equals`, so `buf.subarray(a,b).equals(other)`
 * throws `TypeError: ... .equals is not a function` on device only.
 *
 * So this is genuinely engine-specific, and swapping in the polyfill under
 * vitest does NOT reproduce it. That is exactly why a behavioural test cannot
 * cover this and a source scan has to.
 *
 * It was fixed in packages/core/src/vault.ts (Buffer.compare) but missed in
 * apps/mobile/src/lib/sync.ts, where it threw inside the local-vault check that
 * runs BEFORE the first socket. The mobile error classifier then reported it as
 * "Could not reach the sync server", so a code bug presented as bad wifi and
 * sync was dead on the phone.
 *
 * Use `Buffer.compare(a, b) === 0`, which accepts a Uint8Array and behaves
 * identically on both engines.
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

/**
 * Second guard, for the OTHER binary-type bug this codebase shipped: a raw
 * ArrayBuffer handed to a native module.
 *
 * expo-crypto's digest() falls through to `ExpoCrypto.digest(algorithm, output,
 * data)` on iOS and Android, and ExpoModulesCore resolves that third argument
 * with DynamicTypedArrayType, which requires a TYPED ARRAY and throws
 * NotTypedArrayException on an ArrayBuffer. The declared TS type is
 * `BufferSource`, which INCLUDES ArrayBuffer — so `x.buffer.slice(...) as
 * ArrayBuffer` typechecks, passes every Node test, and dies on the device.
 *
 * `.buffer.slice()` and `as ArrayBuffer` are the two shapes that produced it.
 * Neither has a legitimate use in phone-reachable code today: pass a plain
 * `new Uint8Array(bytes)` across any native boundary instead.
 */
const ARRAYBUFFER_SHAPES = [
  { re: /\.buffer\s*\.slice\s*\(/, why: 'yields an ArrayBuffer; native TypedArray args reject it' },
  { re: /\bas\s+ArrayBuffer\b/, why: 'casts away the very mismatch the compiler was reporting' },
];

/** Only the trees that actually execute on a phone. */
const DEVICE_TREES = ['apps/mobile/src', 'packages/platform-mobile/src'];

describe('native binary-argument guard', () => {
  it('no phone-reachable source builds a raw ArrayBuffer for a native call', () => {
    const offenders: string[] = [];
    for (const rel of DEVICE_TREES.flatMap(sourceFiles)) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      text.split('\n').forEach((line, i) => {
        // Comments explain the bug on purpose; they are not the bug.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const { re, why } of ARRAYBUFFER_SHAPES) {
          if (re.test(code)) offenders.push(`${rel}:${i + 1}: ${why}\n    ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `Pass a plain Uint8Array across native boundaries:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('catches the exact line that broke sync, and ignores the fix and the prose', () => {
    const broke = 'bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + n) as ArrayBuffer,';
    const fixed = 'const view = new Uint8Array(bytes);';
    const prose = '  // into the `.slice() as ArrayBuffer` cast that caused this bug.';
    const hits = (line: string): boolean => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      return ARRAYBUFFER_SHAPES.some(({ re }) => re.test(code));
    };
    expect(hits(broke)).toBe(true);
    expect(hits(fixed)).toBe(false);
    expect(hits(prose)).toBe(false);
  });
});

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
