import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HELPER_SCRIPT, MARKER_PATH, adminScriptArgs, turnOnCommand } from '../src/keep-watch.js';

// Runs the real helper script with its root-only paths pointed at a temp
// directory and pmset/notifyutil replaced by stubs that read state files.
const darwin = process.platform === 'darwin';
const docPath = path.resolve(__dirname, '../../../docs/design/adr-0080-keep-watch.md');

let dir: string;

function write(name: string, text: string, mode = 0o644): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, { mode });
  return file;
}

const SYSTEM_WIDE = (n: number) => `System-wide power settings:\n SleepDisabled\t\t${n}\nCurrently in use:\n standby              1\n`;
const AC_CHARGED = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=23789667)\t100%; charged; 0:00 remaining present: true\n";
const BATTERY = (pct: number) =>
  `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=23789667)\t${pct}%; discharging; 3:10 remaining present: true\n`;

interface Setup {
  sleepDisabled?: number;
  batt?: string;
  thermal?: string;
  pmsetGFails?: boolean;
  battHangs?: boolean;
  heartbeat?: 'fresh' | 'missing' | 'symlink' | 'dir' | number;
  ceiling?: string;
  marker?: boolean;
  perl?: boolean;
  onDisableSleep0?: string;
}

function stubs(s: Setup): string {
  write('state', String(s.sleepDisabled ?? 1));
  write('batt', s.batt ?? AC_CHARGED);
  write('thermal', s.thermal ?? 'com.apple.system.thermalpressurelevel 0\n');
  write('log', '');
  const pmset = write(
    'pmset',
    `#!/bin/sh
d="${dir}"
echo "$*" >> "$d/log"
if [ "$1" = -a ] && [ "$2" = disablesleep ]; then printf %s "$3" > "$d/state"; ${s.onDisableSleep0 ?? ''} exit 0; fi
if [ "$1" = -g ] && [ "$2" = batt ]; then ${s.battHangs ? 'exec /bin/sleep 30' : 'cat "$d/batt"; exit 0'}; fi
if [ "$1" = -g ]; then ${s.pmsetGFails ? 'exit 1' : `printf 'System-wide power settings:\\n SleepDisabled\\t\\t%s\\nCurrently in use:\\n' "$(cat "$d/state")"; exit 0`}; fi
exit 2
`,
    0o755,
  );
  const notify = write('notifyutil', `#!/bin/sh\ncat "${dir}/thermal"\n`, 0o755);
  return HELPER_SCRIPT.replaceAll(MARKER_PATH, path.join(dir, 'marker'))
    .replaceAll('/usr/bin/pmset', pmset)
    .replaceAll('/usr/bin/notifyutil', notify)
    .replaceAll('/usr/bin/perl', s.perl === false ? path.join(dir, 'no-perl') : '/usr/bin/perl');
}

function setup(s: Setup): string {
  const script = stubs(s);
  const hb = path.join(dir, 'heartbeat');
  const now = Math.floor(Date.now() / 1000);
  const hbState = s.heartbeat ?? 'fresh';
  if (hbState === 'symlink') {
    write('real-hb', '');
    fs.symlinkSync(path.join(dir, 'real-hb'), hb);
  } else if (hbState === 'dir') {
    fs.mkdirSync(hb);
  } else if (hbState !== 'missing') {
    write('heartbeat', '');
    const t = hbState === 'fresh' ? now : now + hbState;
    fs.utimesSync(hb, t, t);
  }
  if (s.marker !== false) {
    write('marker', `${hb}\n${s.ceiling ?? String(now + 3600)}\n`, 0o600);
  }
  return script;
}

function run(script: string): { state: string; marker: boolean; ms: number } {
  const start = Date.now();
  spawnSync('/bin/sh', ['-c', script], { timeout: 20_000 });
  return {
    state: fs.readFileSync(path.join(dir, 'state'), 'utf8'),
    marker: fs.existsSync(path.join(dir, 'marker')),
    ms: Date.now() - start,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-keepwatch-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('helper script text', () => {
  it('matches the design record word for word', () => {
    const doc = fs.readFileSync(docPath, 'utf8');
    const block = /```sh\n([\s\S]*?)\n```/.exec(doc)?.[1];
    expect(block).toBe(HELPER_SCRIPT);
  });

  it('writes nothing privileged except turning the mode off and removing its own marker', () => {
    expect(HELPER_SCRIPT).not.toMatch(/disablesleep 1/);
    const writes = HELPER_SCRIPT.match(/pmset -a [a-z]+ \d/g) ?? [];
    expect(new Set(writes)).toEqual(new Set(['pmset -a disablesleep 0']));
    expect(HELPER_SCRIPT.match(/\/bin\/rm -f "\$\w+"/g)).toEqual(['/bin/rm -f "$mk"']);
  });
});

describe.skipIf(!darwin)('helper script behaviour', () => {
  it('does nothing without a marker', () => {
    expect(run(setup({ marker: false, heartbeat: 'missing' }))).toMatchObject({ state: '1', marker: false });
  });

  it('keeps a healthy Keep Watch on', () => {
    expect(run(setup({}))).toMatchObject({ state: '1', marker: true });
  });

  it.each<[string, Setup]>([
    ['heartbeat missing', { heartbeat: 'missing' }],
    ['heartbeat is a symlink', { heartbeat: 'symlink' }],
    ['heartbeat is a directory', { heartbeat: 'dir' }],
    ['heartbeat 91 s old', { heartbeat: -91 }],
    ['heartbeat 61 s in the future', { heartbeat: 61 }],
    ['ceiling passed', { ceiling: String(Math.floor(Date.now() / 1000) - 1) }],
    ['ceiling not a number', { ceiling: '12x' }],
    ['ceiling empty', { ceiling: '' }],
    ['battery at 25%', { batt: BATTERY(25) }],
    ['charger attached but not charging at 20%', { batt: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t20%; AC attached; not charging present: true\n" }],
    ['UPS listed before a 10% internal battery', { batt: "Now drawing from 'UPS Power'\n -UPS-1 (id=9)\t100%; charged; present: true\n -InternalBattery-0 (id=1)\t10%; discharging; 0:30 remaining present: true\n" }],
    ['no internal battery line', { batt: "Now drawing from 'AC Power'\n" }],
    ['thermal pressure heavy', { thermal: 'com.apple.system.thermalpressurelevel 2\n' }],
    ['thermal reading empty', { thermal: '' }],
    ['perl missing', { perl: false }],
  ])('turns off and clears the marker: %s', (_name, s) => {
    expect(run(setup(s))).toMatchObject({ state: '0', marker: false });
  });

  it.each<[string, Setup]>([
    ['battery at 26%', { batt: BATTERY(26) }],
    ['charging at 3%', { batt: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t3%; charging; 2:00 remaining present: true\n" }],
    ['thermal pressure moderate', { thermal: 'com.apple.system.thermalpressurelevel 1\n' }],
    ['heartbeat 55 s in the future', { heartbeat: 55 }],
  ])('stays on: %s', (_name, s) => {
    expect(run(setup(s))).toMatchObject({ state: '1', marker: true });
  });

  it('keeps the marker when it cannot confirm the mode is off, then clears it later', () => {
    const script = setup({ heartbeat: 'missing', pmsetGFails: true });
    expect(run(script)).toMatchObject({ state: '0', marker: true });
    const healthy = stubs({ sleepDisabled: 0 });
    expect(run(healthy)).toMatchObject({ state: '0', marker: false });
  });

  it('turns off within the alarm when a reading hangs', () => {
    const r = run(setup({ battHangs: true }));
    expect(r).toMatchObject({ state: '0', marker: false });
    expect(r.ms).toBeLessThan(10_000);
  }, 20_000);

  it('keeps a marker that a turn-on replaced while it was turning off', () => {
    const fresh = path.join(dir, 'fresh-marker');
    const r = run(
      setup({
        heartbeat: 'missing',
        onDisableSleep0: `if [ "$3" = 0 ]; then printf 'x\\n1\\n' > "${fresh}"; mv -f "${fresh}" "$d/marker"; fi;`,
      }),
    );
    expect(r.marker).toBe(true);
  });
});

describe.skipIf(!darwin)('turn-on command', () => {
  function runTurnOn(hb: string): { code: number; marker: string | null } {
    stubs({ sleepDisabled: 0 });
    const local = turnOnCommand(hb, false).replaceAll(MARKER_PATH, path.join(dir, 'marker')).replaceAll('/usr/bin/pmset', path.join(dir, 'pmset'));
    const r = spawnSync('/bin/sh', ['-c', local]);
    const m = path.join(dir, 'marker');
    return { code: r.status ?? -1, marker: fs.existsSync(m) ? fs.readFileSync(m, 'utf8') : null };
  }

  it.each(['/Users/a b/.northkeep/keep-watch/heartbeat', `/tmp/it's "$(id)" \`id\`/hb`, '/tmp/ünïcode/hb'])(
    'writes the exact path and a root-clock ceiling: %s',
    (hb) => {
      const before = Math.floor(Date.now() / 1000);
      const r = runTurnOn(hb);
      expect(r.code).toBe(0);
      const [line, ceil] = (r.marker ?? '').split('\n');
      expect(line).toBe(hb);
      expect(Number(ceil) - before).toBeGreaterThanOrEqual(43_200);
      expect(Number(ceil) - before).toBeLessThan(43_210);
      expect(fs.readFileSync(path.join(dir, 'state'), 'utf8')).toBe('1');
    },
  );

  it('refuses a path with a newline or a relative path, and leaves the mode off', () => {
    expect(runTurnOn('/tmp/a\n99999999999')).toEqual({ code: 4, marker: null });
    expect(runTurnOn('relative/hb')).toEqual({ code: 3, marker: null });
    expect(fs.readFileSync(path.join(dir, 'state'), 'utf8')).toBe('0');
  });

  it('survives AppleScript quoting unchanged', () => {
    const hb = `/tmp/q"uo\\te's/hb`;
    stubs({ sleepDisabled: 0 });
    const local = turnOnCommand(hb, false)
      .replaceAll(MARKER_PATH, path.join(dir, 'marker'))
      .replaceAll('/usr/bin/pmset', path.join(dir, 'pmset'));
    const [flag, source] = adminScriptArgs(local, 'NorthKeep wants "quotes" \\ here.');
    expect(source).toContain('with prompt "NorthKeep wants \\"quotes\\" \\\\ here." with administrator privileges');
    execFileSync('/usr/bin/osascript', [flag!, source!.replace(/ with prompt ".*" with administrator privileges$/, '')]);
    expect(fs.readFileSync(path.join(dir, 'marker'), 'utf8').split('\n')[0]).toBe(hb);
  });
});
