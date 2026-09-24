import readline from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createReplLines } from '../src/converseInterrupt.js';

const CTRL_C = '\x03';

/** A real readline interface over a fake terminal, the way Converse runs at a TTY. */
function terminal() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
  input.isTTY = true;
  input.setRawMode = () => undefined;
  const output = new PassThrough();
  output.resume();
  const rl = readline.createInterface({ input, output, terminal: true });
  let closed = 0;
  rl.on('close', () => { closed += 1; });
  const lines = createReplLines(rl, () => undefined);
  return { input, rl, lines, closed: () => closed };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('Converse Ctrl-C at an interactive terminal', () => {
  it('closes the REPL input at an idle prompt, as before', async () => {
    const t = terminal();
    const prompt = t.lines.nextLine('you> ');
    t.input.write(CTRL_C);
    await expect(prompt).resolves.toBeNull();
    expect(t.closed()).toBe(1);
  });

  it('cancels a running task instead of closing, and answers its pending approval with null', async () => {
    const t = terminal();
    const controller = new AbortController();
    const end = t.lines.beginTask(() => {
      controller.abort();
      t.lines.releaseWaiters();
    });
    const approval = t.lines.nextLine('Allow web_fetch of https://example.com? [y]es once / [n]o: ');
    t.input.write(CTRL_C);
    await expect(approval).resolves.toBeNull();
    expect(controller.signal.aborted).toBe(true);
    expect(t.closed()).toBe(0);
    end();
    t.rl.close();
  });

  it('delivers the next typed line to the fresh prompt after a cancel', async () => {
    const t = terminal();
    const end = t.lines.beginTask(() => t.lines.releaseWaiters());
    const approval = t.lines.nextLine('Allow? ');
    t.input.write(CTRL_C);
    await approval;
    end();
    const prompt = t.lines.nextLine('you> ');
    t.input.write('hello again\r');
    await expect(prompt).resolves.toBe('hello again');
    t.rl.close();
  });

  it('goes back to closing on Ctrl-C once the task has ended', async () => {
    const t = terminal();
    let cancels = 0;
    const end = t.lines.beginTask(() => { cancels += 1; });
    end();
    t.input.write(CTRL_C);
    await tick();
    expect(cancels).toBe(0);
    expect(t.closed()).toBe(1);
  });
});
