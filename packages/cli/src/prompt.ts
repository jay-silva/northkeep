/**
 * Hidden passphrase input with no dependencies. Order of precedence:
 * NORTHKEEP_PASSPHRASE env var (scripting/tests — mind your shell history),
 * then an interactive no-echo prompt on a TTY.
 */
export async function getPassphrase(promptText: string): Promise<string> {
  const fromEnv = process.env.NORTHKEEP_PASSPHRASE;
  if (fromEnv !== undefined) {
    if (fromEnv.length === 0) throw new Error('NORTHKEEP_PASSPHRASE is set but empty.');
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      'No terminal available to prompt for a passphrase. Set NORTHKEEP_PASSPHRASE or run interactively.',
    );
  }
  return promptHidden(promptText);
}

/** Visible single-line prompt (review flows — not for secrets). */
export function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.resume();
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      stdin.removeListener('data', onData);
      stdin.pause();
      resolve(buffer.slice(0, newline).trim());
    };
    stdin.on('data', onData);
  });
}

function promptHidden(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(promptText);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}
