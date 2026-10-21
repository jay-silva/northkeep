import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HELPER_PLIST,
  HELPER_PLIST_PATH,
  KeepWatchController,
  MARKER_PATH,
  createKeepWatchHandler,
  parseBattery,
  parseSleepDisabled,
  parseThermal,
  type ExecResult,
} from '../src/keep-watch.js';

const AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=23789667)\t100%; charged; 0:00 remaining present: true\n";
const ON_BATTERY = (pct: number) =>
  `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=23789667)\t${pct}%; discharging; 3:10 remaining present: true\n`;

interface FakeMac {
  sleepDisabled: 0 | 1;
  marker: boolean;
  plist: boolean;
  loaded: boolean;
  batt: string;
  thermal: number;
  cancel: boolean;
  adminCommands: string[];
  notices: string[];
}

let home: string;
let now: number;
let mac: FakeMac;

function controller(overrides: { desktop?: boolean; platform?: NodeJS.Platform; perl?: boolean } = {}) {
  return new KeepWatchController({
    platform: () => overrides.platform ?? 'darwin',
    isDesktop: () => overrides.desktop ?? true,
    home: () => home,
    now: () => now,
    exists: (file) =>
      file === MARKER_PATH ? mac.marker : file === HELPER_PLIST_PATH ? mac.plist : file === '/usr/bin/perl' ? overrides.perl !== false : fs.existsSync(file),
    notify: (message) => mac.notices.push(message),
    exec: async (file, args): Promise<ExecResult> => {
      const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });
      if (file === '/usr/bin/pmset' && args.join(' ') === '-g batt') return ok(mac.batt);
      if (file === '/usr/bin/pmset' && args.join(' ') === '-g')
        return ok(`System-wide power settings:\n SleepDisabled\t\t${mac.sleepDisabled}\nCurrently in use:\n`);
      if (file === '/usr/bin/notifyutil') return ok(`com.apple.system.thermalpressurelevel ${mac.thermal}\n`);
      if (file === '/bin/launchctl') return mac.loaded ? ok('state = running') : { code: 113, stdout: '', stderr: 'Could not find service' };
      if (file === '/usr/bin/osascript') {
        const source = args[1] ?? '';
        mac.adminCommands.push(source);
        if (mac.cancel) return { code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' };
        if (source.includes('launchctl bootstrap')) {
          mac.plist = true;
          mac.loaded = true;
        }
        if (source.includes('disablesleep 1')) {
          mac.marker = true;
          mac.sleepDisabled = 1;
        }
        if (source.includes('disablesleep 0')) {
          mac.marker = false;
          mac.sleepDisabled = 0;
        }
        if (source.includes(`rm -f ${HELPER_PLIST_PATH}`)) {
          mac.plist = false;
          mac.loaded = false;
        }
        return ok('');
      }
      return { code: 127, stdout: '', stderr: `unexpected ${file}` };
    },
  });
}

const heartbeat = () => path.join(home, 'keep-watch', 'heartbeat');

/** One run of the real helper's rule: no fresh heartbeat with a marker present means off. */
function helperRuns(): void {
  if (!mac.marker) return;
  const fresh = fs.existsSync(heartbeat()) && now / 1000 - fs.statSync(heartbeat()).mtimeMs / 1000 <= 90;
  if (!fresh) {
    mac.sleepDisabled = 0;
    mac.marker = false;
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-keepwatch-home-'));
  now = Date.UTC(2026, 9, 21, 16, 0, 0);
  mac = { sleepDisabled: 0, marker: false, plist: false, loaded: false, batt: AC, thermal: 0, cancel: false, adminCommands: [], notices: [] };
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('parsers', () => {
  it('reads the real pmset and notifyutil formats', () => {
    expect(parseBattery(AC)).toEqual({ source: 'ac', percent: 100, charging: true, hasBattery: true });
    expect(parseBattery(ON_BATTERY(40))).toEqual({ source: 'battery', percent: 40, charging: false, hasBattery: true });
    expect(parseBattery("Now drawing from 'AC Power'\n")).toMatchObject({ hasBattery: false, percent: null });
    expect(parseThermal('com.apple.system.thermalpressurelevel 0\n')).toBe(0);
    expect(parseThermal('')).toBeNull();
    expect(parseSleepDisabled('System-wide power settings:\n SleepDisabled\t\t0\nCurrently in use:\n sleep 0\n')).toBe(0);
  });

  it('ignores a SleepDisabled line outside the System-wide section', () => {
    const out = 'System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n SleepDisabled 0\n';
    expect(parseSleepDisabled(out)).toBe(1);
    expect(parseSleepDisabled('Currently in use:\n SleepDisabled 0\n')).toBeNull();
  });

  it('builds a valid constant plist', () => {
    const file = path.join(home, 'helper.plist');
    fs.writeFileSync(file, HELPER_PLIST);
    if (process.platform === 'darwin') {
      expect(execFileSync('/usr/bin/plutil', ['-lint', file]).toString()).toContain('OK');
    }
    expect(HELPER_PLIST).toContain('<string>ai.northkeep.keepwatch</string>');
    expect(HELPER_PLIST).not.toContain('<key>Program</key>');
  });
});

describe('Keep Watch controller', () => {
  it('is unavailable outside the Mac app', async () => {
    const handler = createKeepWatchHandler(controller({ desktop: false }));
    const res = await handler('POST', '/api/keep-watch', Buffer.from('{"action":"on","hours":2}'));
    expect(res).toMatchObject({ status: 404 });
    expect((await handler('GET', '/api/keep-watch', Buffer.alloc(0)))?.body).toMatchObject({ supported: false });
    expect(mac.adminCommands).toEqual([]);
  });

  it('installs the helper with the first turn-on, then only asks to turn on', async () => {
    const kw = controller();
    expect(await kw.turnOn(2, false)).toEqual({ ok: true });
    expect(mac.adminCommands[0]).toContain('launchctl bootstrap system');
    expect(mac.adminCommands[0]).toContain('with prompt "NorthKeep wants to turn on Keep Watch and install its helper');
    expect(fs.existsSync(heartbeat())).toBe(true);
    expect((await kw.status()).ends_at).toBe(new Date(now + 2 * 3_600_000).toISOString());
    kw.turnOff();
    helperRuns();
    await kw.tick();
    expect((await kw.status()).state).toBe('off');
    expect(await kw.turnOn(1, false)).toEqual({ ok: true });
    expect(mac.adminCommands[1]).not.toContain('launchctl bootstrap');
  });

  it.each<[string, Partial<FakeMac>, boolean, RegExp]>([
    ['on battery without permission', { batt: ON_BATTERY(80) }, false, /Plug in the charger/],
    ['at the battery floor', { batt: ON_BATTERY(25) }, true, /25%/],
    ['when hot', { thermal: 2 }, false, /running hot/],
    ['without a battery', { batt: "Now drawing from 'AC Power'\n" }, false, /no battery/],
    ['when the helper is disabled in Login Items', { plist: true, loaded: false }, false, /Login Items/],
  ])('refuses to turn on %s', async (_name, state, allowBattery, message) => {
    Object.assign(mac, state);
    const r = await controller().turnOn(2, allowBattery);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(message);
    expect(mac.adminCommands).toEqual([]);
    expect(fs.existsSync(heartbeat())).toBe(false);
  });

  it('refuses when perl is missing', async () => {
    expect(await controller({ perl: false }).turnOn(2, false)).toMatchObject({ ok: false });
  });

  it('allows battery above the floor when asked', async () => {
    mac.batt = ON_BATTERY(60);
    expect(await controller().turnOn(2, true)).toEqual({ ok: true });
  });

  it('leaves everything off when the password prompt is canceled', async () => {
    mac.cancel = true;
    const r = await controller().turnOn(2, false);
    expect(r).toMatchObject({ ok: false, canceled: true });
    expect(fs.existsSync(heartbeat())).toBe(false);
    expect(mac.sleepDisabled).toBe(0);
  });

  it.each<[string, (m: FakeMac) => void, number]>([
    ['the timer ends', () => undefined, 2 * 3_600_000],
    ['the charger is unplugged', (m) => (m.batt = ON_BATTERY(90)), 15_000],
    ['the Mac gets hot', (m) => (m.thermal = 2), 15_000],
    ['heat cannot be read', (m) => (m.thermal = Number.NaN), 15_000],
  ])('turns off when %s', async (_name, change, after) => {
    const kw = controller();
    await kw.turnOn(2, false);
    change(mac);
    now += after;
    await kw.tick();
    expect(fs.existsSync(heartbeat())).toBe(false);
    expect((await kw.status()).state).toBe('turning_off');
    helperRuns();
    await kw.tick();
    expect((await kw.status()).state).toBe('off');
    expect(mac.sleepDisabled).toBe(0);
  });

  it('turns off at the battery floor even when battery is allowed', async () => {
    mac.batt = ON_BATTERY(60);
    const kw = controller();
    await kw.turnOn(2, true);
    mac.batt = ON_BATTERY(25);
    await kw.tick();
    expect((await kw.status()).last_off_reason).toMatch(/25%/);
  });

  it('keeps the heartbeat fresh while on, so the helper leaves it alone', async () => {
    const kw = controller();
    await kw.turnOn(2, false);
    for (let i = 0; i < 20; i += 1) {
      now += 15_000;
      await kw.tick();
      helperRuns();
    }
    expect(mac.sleepDisabled).toBe(1);
    expect((await kw.status()).state).toBe('on');
  });

  it('warns once when the helper stops running mid-session', async () => {
    const kw = controller();
    await kw.turnOn(2, false);
    mac.loaded = false;
    await kw.tick();
    await kw.tick();
    expect(mac.notices).toHaveLength(1);
    expect((await kw.status()).problem).toMatch(/Turn off now/);
    expect(await kw.forceOff()).toBe(true);
    expect(mac.sleepDisabled).toBe(0);
    expect((await kw.status()).state).toBe('off');
  });

  it('shows off, not a problem, when the helper already turned the mode off', async () => {
    const kw = controller();
    await kw.turnOn(2, false);
    mac.marker = false;
    mac.sleepDisabled = 0;
    await kw.tick();
    const status = await kw.status();
    expect(status).toMatchObject({ state: 'off', problem: null, last_off_reason: 'Its safety helper turned it off.' });
    expect(mac.notices).toEqual([]);
    expect(fs.existsSync(heartbeat())).toBe(false);
  });

  it('adds time but never past the 12-hour ceiling', async () => {
    const kw = controller();
    await kw.turnOn(8, false);
    for (let i = 0; i < 3; i += 1) expect(kw.extend()).toBe(true);
    expect(kw.extend()).toBe(true);
    expect(kw.extend()).toBe(false);
    const status = await kw.status();
    expect(Date.parse(status.ends_at!)).toBe(now + 12 * 3_600_000 - 60_000);
  });

  it('deletes the heartbeat on quit and on the next start', async () => {
    const kw = controller();
    await kw.turnOn(2, false);
    kw.stop();
    expect(fs.existsSync(heartbeat())).toBe(false);
    fs.writeFileSync(heartbeat(), '');
    const next = controller();
    await next.start();
    next.stop();
    expect(fs.existsSync(heartbeat())).toBe(false);
    expect((await next.status()).last_off_reason).toMatch(/earlier run/);
  });

  it('removes the helper and turns the mode off', async () => {
    const kw = controller();
    await kw.turnOn(2, false);
    expect(await kw.removeHelper()).toBe(true);
    expect(mac).toMatchObject({ plist: false, loaded: false, marker: false, sleepDisabled: 0 });
    expect((await kw.status()).helper).toBe('missing');
  });
});
