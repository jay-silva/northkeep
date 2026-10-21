// Keep Watch (ADR 0080): keeps a MacBook awake with the lid closed. The
// controller runs here in the local server; the root helper it installs can
// only ever turn the mode off, and does so whenever this server stops
// refreshing the heartbeat. The helper script below must match
// docs/design/adr-0080-keep-watch.md word for word (a test checks).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';

export const HELPER_SCRIPT = [
  "mk=/var/db/ai.northkeep.keepwatch",
  "[ -f \"$mk\" ] && [ ! -L \"$mk\" ] || exit 0",
  "t5() { /usr/bin/perl -e 'alarm shift; exec @ARGV or exit 127' 5 \"$@\"; }",
  "id=$(/usr/bin/stat -f %i:%m \"$mk\" 2>/dev/null) || id=x",
  "off() {",
  "  [ -x /usr/bin/perl ] || t5() { \"$@\"; }",
  "  t5 /usr/bin/pmset -a disablesleep 0",
  "  s=$(t5 /usr/bin/pmset -g | /usr/bin/awk '/^System-wide power settings:/{f=1;next} /^[^ \\t]/{f=0} f&&$1==\"SleepDisabled\"{print $2;exit}')",
  "  [ \"$s\" = 0 ] && [ \"$(/usr/bin/stat -f %i:%m \"$mk\" 2>/dev/null)\" = \"$id\" ] && /bin/rm -f \"$mk\"",
  "  exit 0",
  "}",
  "now=$(/bin/date +%s)",
  "{ IFS= read -r hb && IFS= read -r ceil; } < \"$mk\" || off",
  "case \"$ceil\" in ''|*[!0-9]*) off ;; esac",
  "[ \"$now\" -lt \"$ceil\" ] || off",
  "case \"$hb\" in /*) ;; *) off ;; esac",
  "m=$(t5 /usr/bin/stat -f '%HT|%m' \"$hb\" 2>/dev/null) || off",
  "case \"$m\" in \"Regular File|\"*) m=${m#*|} ;; *) off ;; esac",
  "case \"$m\" in ''|*[!0-9]*) off ;; esac",
  "age=$((now - m))",
  "[ \"$age\" -le 90 ] && [ \"$age\" -ge -60 ] || off",
  "b=$(t5 /usr/bin/pmset -g batt) || off",
  "l=$(printf '%s\\n' \"$b\" | /usr/bin/grep -m1 'InternalBattery')",
  "p=$(printf '%s' \"$l\" | /usr/bin/grep -Eo '[0-9]+%' | /usr/bin/head -1 | /usr/bin/tr -d %)",
  "case \"$p\" in ''|*[!0-9]*) off ;; esac",
  "case \"$l\" in *\"; charging;\"*|*\"; charged;\"*|*\"; finishing charge;\"*) ;; *) [ \"$p\" -gt 25 ] || off ;; esac",
  "t=$(t5 /usr/bin/notifyutil -g com.apple.system.thermalpressurelevel) || off",
  "t=${t##* }",
  "case \"$t\" in ''|*[!0-9]*) off ;; esac",
  "[ \"$t\" -lt 2 ] || off",
  "exit 0",
].join("\n");

export const HELPER_LABEL = 'ai.northkeep.keepwatch';
export const HELPER_PLIST_PATH = `/Library/LaunchDaemons/${HELPER_LABEL}.plist`;
export const MARKER_PATH = `/var/db/${HELPER_LABEL}`;
export const TIMER_HOURS = [1, 2, 4, 8] as const;
export const CEILING_MS = 12 * 60 * 60 * 1000;
export const BATTERY_FLOOR = 25;
export const TICK_MS = 15_000;

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A constant: nothing from the user's side is ever spliced in (ADR 0080 D4).
export const HELPER_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '  <key>Label</key>',
  `  <string>${HELPER_LABEL}</string>`,
  '  <key>ProgramArguments</key>',
  '  <array>',
  '    <string>/bin/sh</string>',
  '    <string>-c</string>',
  `    <string>${xmlEscape(HELPER_SCRIPT)}</string>`,
  '  </array>',
  '  <key>StartInterval</key>',
  '  <integer>15</integer>',
  '  <key>RunAtLoad</key>',
  '  <true/>',
  '  <key>AssociatedBundleIdentifiers</key>',
  '  <string>ai.northkeep.desktop</string>',
  '</dict>',
  '</plist>',
  '',
].join('\n');

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Root shell for turn-on. The heartbeat path travels as base64; the ceiling comes from root's own clock. */
export function turnOnCommand(heartbeatPath: string, installHelper: boolean): string {
  const lines = ['set -e'];
  if (installHelper) {
    lines.push(
      `pl=$(printf %s '${b64(HELPER_PLIST)}' | /usr/bin/base64 -D)`,
      `tp=$(/usr/bin/mktemp /var/db/${HELPER_LABEL}.plist.XXXXXX)`,
      `printf '%s\\n' "$pl" > "$tp"`,
      '/usr/sbin/chown root:wheel "$tp"',
      '/bin/chmod 644 "$tp"',
      `/bin/mv -f "$tp" ${HELPER_PLIST_PATH}`,
      `/bin/launchctl bootout system/${HELPER_LABEL} 2>/dev/null || true`,
      `/bin/launchctl bootstrap system ${HELPER_PLIST_PATH}`,
    );
  }
  lines.push(
    `hb=$(printf %s '${b64(heartbeatPath)}' | /usr/bin/base64 -D)`,
    'case "$hb" in /*) ;; *) exit 3 ;; esac',
    "nl='",
    "'",
    'case "$hb" in *"$nl"*) exit 4 ;; esac',
    `ceil=$(( $(/bin/date +%s) + ${CEILING_MS / 1000} ))`,
    `tm=$(/usr/bin/mktemp ${MARKER_PATH}.XXXXXX)`,
    `printf '%s\\n%s\\n' "$hb" "$ceil" > "$tm"`,
    '/bin/chmod 600 "$tm"',
    `/bin/mv -f "$tm" ${MARKER_PATH}`,
    '/usr/bin/pmset -a disablesleep 1',
  );
  return lines.join('\n');
}

export const FORCE_OFF_COMMAND = ['set -e', '/usr/bin/pmset -a disablesleep 0', `/bin/rm -f ${MARKER_PATH}`].join('\n');

export const REMOVE_HELPER_COMMAND = [
  '/usr/bin/pmset -a disablesleep 0',
  `/bin/rm -f ${MARKER_PATH}`,
  `/bin/launchctl bootout system/${HELPER_LABEL} 2>/dev/null || true`,
  `/bin/rm -f ${HELPER_PLIST_PATH}`,
].join('\n');

/** `osascript` arguments that run a root shell command behind the macOS admin prompt. */
export function adminScriptArgs(command: string): string[] {
  const quoted = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return ['-e', `do shell script "${quoted}" with administrator privileges`];
}

export interface PowerReading {
  source: 'ac' | 'battery' | 'unknown';
  percent: number | null;
  charging: boolean;
  hasBattery: boolean;
}

export function parseBattery(out: string): PowerReading {
  const source = /'AC Power'/.test(out) ? 'ac' : /'Battery Power'/.test(out) ? 'battery' : 'unknown';
  const line = out.split('\n').find((l) => l.includes('InternalBattery'));
  if (!line) return { source, percent: null, charging: false, hasBattery: false };
  const pct = /(\d+)%/.exec(line);
  return {
    source,
    percent: pct ? Number(pct[1]) : null,
    charging: /; (charging|charged|finishing charge);/.test(line),
    hasBattery: true,
  };
}

export function parseThermal(out: string): number | null {
  const last = out.trim().split(/\s+/).pop() ?? '';
  return /^\d+$/.test(last) ? Number(last) : null;
}

/** `SleepDisabled` from the System-wide section only; process names elsewhere in the output are user-chosen. */
export function parseSleepDisabled(out: string): 0 | 1 | null {
  let inSection = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('System-wide power settings:')) {
      inSection = true;
      continue;
    }
    if (/^\S/.test(line)) inSection = false;
    if (!inSection) continue;
    const m = /^\s+SleepDisabled\s+(\d+)\s*$/.exec(line);
    if (m) return m[1] === '1' ? 1 : m[1] === '0' ? 0 : null;
  }
  return null;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface KeepWatchDependencies {
  platform: () => NodeJS.Platform;
  isDesktop: () => boolean;
  home: () => string;
  now: () => number;
  exec: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
  exists: (file: string) => boolean;
  notify: (message: string) => void;
}

function defaultExec(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const defaults: KeepWatchDependencies = {
  platform: () => process.platform,
  isDesktop: () => process.env.NORTHKEEP_DESKTOP === '1',
  home: () => northkeepHome(),
  now: () => Date.now(),
  exec: defaultExec,
  exists: (file) => fs.existsSync(file),
  notify: (message) => {
    const text = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execFile('/usr/bin/osascript', ['-e', `display notification "${text}" with title "NorthKeep"`], { timeout: 5000 }, () => {});
  },
};

export type KeepWatchState = 'off' | 'on' | 'turning_off';
export type HelperState = 'installed' | 'missing' | 'disabled';

export interface KeepWatchStatus {
  supported: boolean;
  state: KeepWatchState;
  hours: number;
  allow_battery: boolean;
  ends_at: string | null;
  ceiling_at: string | null;
  helper: HelperState;
  power: PowerReading;
  thermal: number | null;
  last_off_reason: string | null;
  problem: string | null;
}

const OFF_REASONS: Record<string, string> = {
  timer: 'The timer ran out.',
  unplugged: 'The charger was unplugged.',
  battery: `Battery reached ${BATTERY_FLOOR}%.`,
  heat: 'The Mac was running hot.',
  user: 'You turned it off.',
  quit: 'NorthKeep quit.',
  startup: 'NorthKeep found it left on from an earlier run.',
  helper: 'Its safety helper turned it off.',
};

const HELPER_DISABLED =
  'Keep Watch’s helper is turned off in System Settings, General, Login Items. Turn on NorthKeep there, then try again.';
const CANNOT_SELF_OFF =
  'Keep Watch can’t turn itself off: its helper stopped running. Use Turn off now and enter your Mac password.';

export class KeepWatchController {
  private deps: KeepWatchDependencies;
  private state: KeepWatchState = 'off';
  private hours = 2;
  private allowBattery = false;
  private onAt = 0;
  private endsAt = 0;
  private turningOffSince = 0;
  private lastOffReason: string | null = null;
  private problem: string | null = null;
  private notified = false;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private power: PowerReading = { source: 'unknown', percent: null, charging: false, hasBattery: false };
  private thermal: number | null = null;

  constructor(overrides: Partial<KeepWatchDependencies> = {}) {
    this.deps = { ...defaults, ...overrides };
  }

  supported(): boolean {
    return this.deps.platform() === 'darwin' && this.deps.isDesktop();
  }

  heartbeatPath(): string {
    return path.join(this.deps.home(), 'keep-watch', 'heartbeat');
  }

  /** Server start: any heartbeat left by an earlier run is deleted, so the helper turns that run's mode off. */
  async start(): Promise<void> {
    if (!this.supported()) return;
    if (this.removeHeartbeat() && this.deps.exists(MARKER_PATH)) this.beginTurningOff('startup');
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  /** Server shutdown: synchronous, so it runs even on a fast exit. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.state === 'on') this.lastOffReason = OFF_REASONS.quit ?? null;
    this.removeHeartbeat();
  }

  private removeHeartbeat(): boolean {
    try {
      fs.unlinkSync(this.heartbeatPath());
      return true;
    } catch {
      return false;
    }
  }

  private touchHeartbeat(): void {
    const file = this.heartbeatPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const t = new Date(this.deps.now());
    try {
      fs.utimesSync(file, t, t);
    } catch {
      fs.writeFileSync(file, '', { mode: 0o600 });
      fs.utimesSync(file, t, t);
    }
  }

  private async read(file: string, args: string[]): Promise<string | null> {
    const r = await this.deps.exec(file, args, 5000);
    return r.code === 0 ? r.stdout : null;
  }

  private async readings(): Promise<void> {
    const batt = await this.read('/usr/bin/pmset', ['-g', 'batt']);
    this.power = batt === null ? { source: 'unknown', percent: null, charging: false, hasBattery: false } : parseBattery(batt);
    const therm = await this.read('/usr/bin/notifyutil', ['-g', 'com.apple.system.thermalpressurelevel']);
    this.thermal = therm === null ? null : parseThermal(therm);
  }

  private async helperState(): Promise<HelperState> {
    if (!this.deps.exists(HELPER_PLIST_PATH)) return 'missing';
    const r = await this.deps.exec('/bin/launchctl', ['print', `system/${HELPER_LABEL}`], 5000);
    return r.code === 0 ? 'installed' : 'disabled';
  }

  /** Why Keep Watch must not be on right now, or null. Unknown readings count as a reason. */
  private offReason(): string | null {
    if (this.deps.now() >= this.endsAt) return 'timer';
    const p = this.power;
    if (!p.hasBattery || p.percent === null) return 'battery';
    if (p.source !== 'ac' && !this.allowBattery) return 'unplugged';
    if (!p.charging && p.percent <= BATTERY_FLOOR) return 'battery';
    if (this.thermal === null || this.thermal >= 2) return 'heat';
    return null;
  }

  private beginTurningOff(reason: string): void {
    this.removeHeartbeat();
    this.state = 'turning_off';
    this.turningOffSince = this.deps.now();
    this.lastOffReason = OFF_REASONS[reason] ?? reason;
  }

  async tick(): Promise<void> {
    if (this.state === 'on') {
      this.touchHeartbeat();
      await this.readings();
      const reason = this.offReason();
      if (reason) {
        this.beginTurningOff(reason);
      } else if ((await this.helperState()) !== 'installed' || !this.deps.exists(MARKER_PATH)) {
        // The helper reads on its own and fails closed, so it may already have turned the mode off.
        const out = await this.read('/usr/bin/pmset', ['-g']);
        if (out !== null && parseSleepDisabled(out) === 0) {
          this.removeHeartbeat();
          this.state = 'off';
          this.lastOffReason = OFF_REASONS.helper ?? null;
          this.problem = null;
        } else {
          this.problem = CANNOT_SELF_OFF;
          if (!this.notified) this.deps.notify(CANNOT_SELF_OFF);
          this.notified = true;
        }
      }
    }
    if (this.state === 'turning_off') {
      const out = await this.read('/usr/bin/pmset', ['-g']);
      if (out !== null && parseSleepDisabled(out) === 0) {
        this.state = 'off';
        this.problem = null;
        this.notified = false;
      } else if (this.deps.now() - this.turningOffSince > 60_000) {
        this.problem = CANNOT_SELF_OFF;
      }
    }
  }

  async status(): Promise<KeepWatchStatus> {
    const supported = this.supported();
    if (supported) await this.readings();
    return {
      supported,
      state: this.state,
      hours: this.hours,
      allow_battery: this.allowBattery,
      ends_at: this.state === 'on' ? new Date(this.endsAt).toISOString() : null,
      ceiling_at: this.state === 'on' ? new Date(this.onAt + CEILING_MS).toISOString() : null,
      helper: supported ? await this.helperState() : 'missing',
      power: this.power,
      thermal: this.thermal,
      last_off_reason: this.lastOffReason,
      problem: this.problem,
    };
  }

  private async admin(command: string): Promise<ExecResult> {
    return this.deps.exec('/usr/bin/osascript', adminScriptArgs(command), 5 * 60_000);
  }

  async turnOn(hours: number, allowBattery: boolean): Promise<{ ok: true } | { ok: false; status: number; error: string; canceled?: boolean }> {
    if (!this.supported()) return { ok: false, status: 404, error: 'Keep Watch runs only in the NorthKeep Mac app.' };
    if (!(TIMER_HOURS as readonly number[]).includes(hours)) return { ok: false, status: 400, error: 'Pick 1, 2, 4 or 8 hours.' };
    if (this.state !== 'off') return { ok: false, status: 409, error: 'Keep Watch is already on.' };
    if (this.busy) return { ok: false, status: 409, error: 'Keep Watch is waiting for your password.' };
    if (!this.deps.exists('/usr/bin/perl')) return { ok: false, status: 409, error: 'This version of macOS is missing a tool Keep Watch needs to turn itself off safely.' };
    const hb = this.heartbeatPath();
    if (!path.isAbsolute(hb) || /[\r\n]/.test(hb)) return { ok: false, status: 409, error: 'NorthKeep’s data folder has a name Keep Watch can’t use.' };
    this.allowBattery = allowBattery;
    this.endsAt = this.deps.now() + hours * 3_600_000;
    await this.readings();
    const reason = this.offReason();
    if (reason === 'battery' && !this.power.hasBattery) return { ok: false, status: 409, error: 'Keep Watch is for Mac laptops; this Mac has no battery.' };
    if (reason) return { ok: false, status: 409, error: refuseMessage(reason) };
    const helper = await this.helperState();
    if (helper === 'disabled') return { ok: false, status: 409, error: HELPER_DISABLED };
    this.busy = true;
    try {
      this.touchHeartbeat();
      const r = await this.admin(turnOnCommand(hb, helper === 'missing'));
      if (r.code !== 0) {
        this.removeHeartbeat();
        if (/-128|User cancel/i.test(r.stderr)) return { ok: false, status: 409, error: 'Keep Watch stayed off.', canceled: true };
        return { ok: false, status: 500, error: 'macOS did not turn Keep Watch on.' };
      }
      const out = await this.read('/usr/bin/pmset', ['-g']);
      if (out === null || parseSleepDisabled(out) !== 1) {
        this.beginTurningOff('Keep Watch could not confirm it was on.');
        return { ok: false, status: 500, error: 'macOS did not confirm Keep Watch was on, so NorthKeep is turning it off.' };
      }
      this.state = 'on';
      this.hours = hours;
      this.onAt = this.deps.now();
      this.endsAt = this.onAt + hours * 3_600_000;
      this.problem = null;
      this.notified = false;
      this.touchHeartbeat();
      return { ok: true };
    } finally {
      this.busy = false;
    }
  }

  turnOff(): void {
    if (this.state === 'on') this.beginTurningOff('user');
  }

  /** One more hour, never past the root-set ceiling (less a minute for clock skew between us and root). */
  extend(): boolean {
    if (this.state !== 'on') return false;
    const cap = this.onAt + CEILING_MS - 60_000;
    if (this.endsAt >= cap) return false;
    this.endsAt = Math.min(this.endsAt + 3_600_000, cap);
    return true;
  }

  async forceOff(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      this.beginTurningOff('user');
      const r = await this.admin(FORCE_OFF_COMMAND);
      await this.tick();
      return r.code === 0;
    } finally {
      this.busy = false;
    }
  }

  async removeHelper(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      if (this.state === 'on') this.beginTurningOff('user');
      const r = await this.admin(REMOVE_HELPER_COMMAND);
      if (r.code === 0) {
        this.state = 'off';
        this.problem = null;
      }
      return r.code === 0;
    } finally {
      this.busy = false;
    }
  }
}

function refuseMessage(reason: string): string {
  switch (reason) {
    case 'unplugged':
      return 'Plug in the charger, or choose Allow on battery.';
    case 'battery':
      return `Battery is at ${BATTERY_FLOOR}% or less. Plug in the charger first.`;
    case 'heat':
      return 'The Mac is running hot, or NorthKeep could not read its temperature. Try again when it cools.';
    default:
      return 'Keep Watch can’t turn on right now.';
  }
}

export interface KeepWatchResponse {
  status: number;
  body: unknown;
}

export function createKeepWatchHandler(controller: KeepWatchController) {
  return async (method: string, route: string, body: Buffer): Promise<KeepWatchResponse | null> => {
    if (route !== '/api/keep-watch') return null;
    if (method === 'GET') return { status: 200, body: await controller.status() };
    if (method !== 'POST') return { status: 405, body: { error: 'Use GET or POST.' } };
    let req: { action?: unknown; hours?: unknown; allow_battery?: unknown };
    try {
      req = JSON.parse(body.toString('utf8') || '{}') as typeof req;
    } catch {
      return { status: 400, body: { error: 'The request was not valid JSON.' } };
    }
    if (!controller.supported()) return { status: 404, body: { error: 'Keep Watch runs only in the NorthKeep Mac app.' } };
    switch (req.action) {
      case 'on': {
        const r = await controller.turnOn(Number(req.hours), req.allow_battery === true);
        if (!r.ok) return { status: r.status, body: { error: r.error, canceled: r.canceled === true } };
        break;
      }
      case 'off':
        controller.turnOff();
        break;
      case 'extend':
        if (!controller.extend()) return { status: 409, body: { error: 'Keep Watch can’t run past 12 hours without a new start.' } };
        break;
      case 'force_off':
        if (!(await controller.forceOff())) return { status: 409, body: { error: 'Keep Watch stayed on. Try again and enter your Mac password.' } };
        break;
      case 'remove_helper':
        if (!(await controller.removeHelper())) return { status: 409, body: { error: 'The helper was not removed.' } };
        break;
      default:
        return { status: 400, body: { error: 'Unknown action.' } };
    }
    return { status: 200, body: await controller.status() };
  };
}

export const keepWatch = new KeepWatchController();
export const handleKeepWatchApi = createKeepWatchHandler(keepWatch);
