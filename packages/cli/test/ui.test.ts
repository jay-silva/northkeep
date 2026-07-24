import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpinner } from '../src/ui.js';

/** Everything written to stdout, ANSI-stripped, since the last reset. */
let writes: string[] = [];
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const originalIsTTY = process.stdout.isTTY;
let writeSpy: ReturnType<typeof vi.spyOn>;

const setTTY = (value: boolean): void => {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
};

beforeEach(() => {
  vi.useFakeTimers();
  writes = [];
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.useRealTimers();
  writeSpy.mockRestore();
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
});

describe('createSpinner', () => {
  it('is a no-op when stdout is not a TTY (piped output stays byte-clean)', () => {
    setTTY(false);
    const spinner = createSpinner();
    spinner.start();
    vi.advanceTimersByTime(500);
    spinner.stop();
    expect(writes).toEqual([]);
  });

  it('draws immediately on start and animates frames on a TTY', () => {
    setTTY(true);
    const spinner = createSpinner();
    spinner.start();
    expect(writes.length).toBe(1);
    expect(stripAnsi(writes[0]!)).toBe('\r⠋ thinking…');
    vi.advanceTimersByTime(80);
    expect(stripAnsi(writes[1]!)).toBe('\r⠙ thinking…');
    spinner.stop();
  });

  it('stop clears the line, is idempotent, and allows restarting', () => {
    setTTY(true);
    const spinner = createSpinner();
    spinner.start();
    spinner.stop();
    expect(writes.at(-1)).toBe('\r\x1b[2K');
    const count = writes.length;
    spinner.stop(); // second stop: nothing more written
    vi.advanceTimersByTime(500); // and the interval is really gone
    expect(writes.length).toBe(count);
    spinner.start(); // restart draws again
    expect(stripAnsi(writes.at(-1)!)).toMatch(/thinking…$/);
    spinner.stop();
  });

  it('start is idempotent while already spinning', () => {
    setTTY(true);
    const spinner = createSpinner();
    spinner.start();
    const count = writes.length;
    spinner.start();
    expect(writes.length).toBe(count);
    spinner.stop();
  });
});
