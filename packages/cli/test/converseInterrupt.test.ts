import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createReplLines } from '../src/converseInterrupt.js';

const CTRL_C = '\x03';

/** A real readline interface over a fake terminal, wired the way converseCmd wires it. */
function terminal(interactive = true) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
  input.isTTY = interactive;
  input.setRawMode = () => undefined;
  const output = new PassThrough();
  output.resume();
  const rl = readline.createInterface({ input, output, terminal: interactive });
  let closed = 0;
  rl.on('close', () => { closed += 1; });
  const signals = new EventEmitter();
  const lines = createReplLines(
    rl,
    () => undefined,
    { interactive: rl.terminal, clearPartial: () => rl.write(null, { ctrl: true, name: 'u' }) },
    signals,
  );
  return { input, rl, lines, signals, closed: () => closed };
}

const tick = () => new Promise((r) => setImmediate(r));

/** A task that waits on an approval prompt until it is answered or cancelled. */
function approvalTask(t: ReturnType<typeof terminal>) {
  let answer: string | null | undefined;
  const run = t.lines.runCancellable(
    async (signal) => {
      answer = await t.lines.nextLine('Allow? ', { freshInput: true });
      return signal.aborted;
    },
    () => undefined,
  );
  return { run, answer: () => answer };
}

describe('Converse Ctrl-C at an interactive terminal', () => {
  it('closes the REPL input at an idle prompt, as before', async () => {
    const t = terminal();
    const prompt = t.lines.nextLine('you> ');
    t.input.write(CTRL_C);
    await expect(prompt).resolves.toBeNull();
    expect(t.closed()).toBe(1);
  });

  it('cancels a running task instead of closing, answering its pending approval with null', async () => {
    const t = terminal();
    let cancels = 0;
    const run = t.lines.runCancellable(
      async (signal) => {
        const answer = await t.lines.nextLine('Allow? ', { freshInput: true });
        return { answer, aborted: signal.aborted };
      },
      () => { cancels += 1; },
    );
    await tick();
    t.input.write(CTRL_C);
    t.input.write(CTRL_C); // a second press while cancelling is not a second cancel
    const { value, cancelled } = await run;
    expect(value).toEqual({ answer: null, aborted: true });
    expect(cancelled).toBe(true);
    expect(cancels).toBe(1);
    expect(t.closed()).toBe(0);
    t.rl.close();
  });

  it('cancels on the process SIGINT too (stdin not a terminal), and unhooks it afterwards', async () => {
    const t = terminal();
    const run = t.lines.runCancellable((signal) => new Promise<boolean>((r) => signal.addEventListener('abort', () => r(true))), () => undefined);
    t.signals.emit('SIGINT');
    await expect(run).resolves.toEqual({ value: true, cancelled: true });
    expect(t.signals.listenerCount('SIGINT')).toBe(0);
    t.rl.close();
  });

  it('goes back to closing on Ctrl-C once the task has ended', async () => {
    const t = terminal();
    await t.lines.runCancellable(async () => 1, () => undefined);
    t.input.write(CTRL_C);
    await tick();
    expect(t.closed()).toBe(1);
  });
});

describe('typeahead cannot answer an approval it did not see', () => {
  it('discards a line entered before the approval prompt appeared', async () => {
    const t = terminal();
    t.input.write('y\r'); // typed while the model was still thinking
    await tick();
    const task = approvalTask(t);
    await tick();
    expect(task.answer()).toBeUndefined(); // still waiting: the early y was dropped
    t.input.write('n\r');
    await task.run;
    expect(task.answer()).toBe('n');
    t.rl.close();
  });

  it('clears a partly typed y so Enter after the prompt answers with nothing', async () => {
    const t = terminal();
    t.input.write('y'); // no Enter yet
    await tick();
    const task = approvalTask(t);
    await tick();
    t.input.write('\r');
    await task.run;
    expect(task.answer()).toBe('');
    t.rl.close();
  });

  it('after a cancel, a line typed during the task is not sent as the next turn', async () => {
    const t = terminal();
    const run = t.lines.runCancellable(async (signal) => {
      await new Promise((r) => signal.addEventListener('abort', r));
    }, () => undefined);
    t.input.write('hello again\r'); // typed mid-task, not at a prompt
    await tick();
    t.input.write(CTRL_C);
    await run;
    const next = t.lines.nextLine('you> ', { freshInput: true });
    await tick();
    t.input.write('fresh\r');
    await expect(next).resolves.toBe('fresh');
    t.rl.close();
  });

  it('leaves piped input alone: scripted lines still answer in order', async () => {
    const t = terminal(false);
    t.input.write('y\n');
    await tick();
    await expect(t.lines.nextLine('Allow? ', { freshInput: true })).resolves.toBe('y');
    t.rl.close();
  });
});

describe('converseCmd wiring', () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'converseCmd.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const calls = (name: string): ts.CallExpression[] => {
    const out: ts.CallExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText() === name) out.push(n);
      n.forEachChild(visit);
    };
    visit(source);
    return out;
  };

  it('runs the tool task inside runCancellable and hands runTask its signal', () => {
    const [cancellable] = calls('lines.runCancellable');
    expect(cancellable).toBeDefined();
    const runner = cancellable!.arguments[0]!;
    expect(ts.isArrowFunction(runner)).toBe(true);
    const param = (runner as ts.ArrowFunction).parameters[0]!.name.getText();
    const runTask = calls('runTask').find((c) => c.pos >= runner.pos && c.end <= runner.end);
    expect(runTask).toBeDefined();
    const opts = runTask!.arguments[0] as ts.ObjectLiteralExpression;
    const signal = opts.properties.find((p) => p.name?.getText() === 'signal');
    expect(signal?.getText()).toBe(param === 'signal' ? 'signal' : `signal: ${param}`);
    expect(calls('runTask')).toHaveLength(1);
  });

  it('asks for approval with fresh input only, and wires the terminal flag', () => {
    const approval = calls('nextLine').filter((c) => c.arguments[0]!.getText().includes('options'));
    expect(approval).toHaveLength(1);
    expect(approval[0]!.arguments[1]?.getText()).toBe('{ freshInput: true }');
    const [create] = calls('createReplLines');
    const opts = create!.arguments[2] as ts.ObjectLiteralExpression;
    expect(opts.properties.find((p) => p.name?.getText() === 'interactive')?.getText()).toBe('interactive: rl.terminal');
  });
});
