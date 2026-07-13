import readline from 'node:readline';
import { c, DIM, RESET } from './ui.js';
import {
  addEndpoint,
  costLabel,
  getDefaultEndpoint,
  KNOWN_PROVIDERS,
  listEndpoints,
  lookupModel,
  detectHardware,
  recommendLocalModel,
  setDefaultEndpoint,
} from '@northkeep/converse';
import { createOllamaClient, ollamaState, type PullProgress } from '@northkeep/librarian';

/**
 * `northkeep models` (M9b/M9c, ADR 0014) — effortless model setup for a
 * non-engineer: list what's connected, a guided "connect a hosted model" flow
 * over the curated provider registry, and a 1-click hardware-matched local
 * install via Ollama. API keys flow ONLY through addEndpoint → Keychain; they
 * are never printed, logged, or written to providers.json here.
 */

/**
 * A robust line reader: queue lines rather than await rl.question(), so pasted
 * input and piped scripting never drop lines that arrive mid-await. (Same
 * pattern as converseCmd.ts.)
 */
function createLineReader(): { nextLine: (prompt: string) => Promise<string | null>; close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pending: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on('line', (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else pending.push(l);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()!(null);
  });
  const nextLine = (prompt: string): Promise<string | null> => {
    if (pending.length > 0) return Promise.resolve(pending.shift()!);
    if (closed) return Promise.resolve(null);
    process.stdout.write(prompt);
    return new Promise((r) => waiters.push(r));
  };
  return { nextLine, close: () => rl.close() };
}

/** Parse a 1-based menu choice; returns a 0-based index or null. */
function parseChoice(raw: string | null, count: number): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > count) return null;
  return n - 1;
}

function costFor(modelId: string): string {
  const entry = lookupModel(modelId);
  if (!entry) return '';
  const { symbol, range } = costLabel(entry.costTier);
  return `${symbol} ${c.dim(range)}`;
}

/** `northkeep models list` — configured endpoints, cost, default, local state. */
export async function modelsList(): Promise<void> {
  const endpoints = listEndpoints();
  if (endpoints.length === 0) {
    console.log('No models connected yet.');
    console.log(`  Connect a hosted model:  ${c.bold('northkeep models add')}`);
    console.log(`  Install a local model:   ${c.bold('northkeep models install')}`);
  } else {
    const defaultId = getDefaultEndpoint()?.id;
    console.log(c.muted('  Connected models'));
    for (const ep of endpoints) {
      const mark = ep.id === defaultId ? c.green('*') : ' ';
      const cost = costFor(ep.model);
      console.log(
        `  ${mark} ${c.bold(ep.label)}  ${c.dim(`${ep.id} · ${ep.model}`)}${cost ? `  ${cost}` : ''}`,
      );
    }
    console.log(c.muted('\n  (* = default. Set with: northkeep models add, or northkeep providers default <id>)'));
  }
  const state = await ollamaState();
  const localLabel =
    state === 'ready'
      ? c.green('ready')
      : state === 'no-models'
        ? c.yellow('installed, no models — run "northkeep models install"')
        : c.muted('not installed — run "northkeep models install" to set up');
  console.log(`\n  ${c.muted('Local AI')}  ${localLabel}`);
}

/** `northkeep models add` — guided hosted-provider onboarding. */
export async function modelsAdd(): Promise<void> {
  const io = createLineReader();
  try {
    console.log(c.bold('\nConnect a model'));
    console.log(c.muted('Pick a provider. You will get a link for the API key, then choose a model.\n'));
    KNOWN_PROVIDERS.forEach((p, i) => {
      console.log(`  ${c.bold(String(i + 1).padStart(2))}. ${p.name}`);
    });
    const providerIdx = parseChoice(await io.nextLine('\nProvider number: '), KNOWN_PROVIDERS.length);
    if (providerIdx === null) {
      console.log('No provider selected. Nothing changed.');
      return;
    }
    const provider = KNOWN_PROVIDERS[providerIdx]!;

    console.log(`\n${c.bold(provider.name)} — how to get an API key:`);
    console.log(`  ${c.pine(provider.keyUrl)}`);
    provider.keySteps.forEach((step) => console.log(`    ${c.muted('·')} ${step}`));

    // The key goes straight to addEndpoint → Keychain. It is never echoed to a
    // log, never written to providers.json, never printed back.
    const rawKey = await io.nextLine('\nPaste your API key: ');
    const apiKey = (rawKey ?? '').trim();
    if (!apiKey) {
      console.log('No key entered. Nothing changed.');
      return;
    }
    if (provider.keyPrefix && !apiKey.startsWith(provider.keyPrefix)) {
      // Soft validation — warn, don't block (key formats drift).
      console.log(
        c.yellow(`⚠  That key doesn't start with "${provider.keyPrefix}" — double-check it, but I'll proceed.`),
      );
    }

    console.log(`\n${c.bold(provider.name)} models:`);
    provider.models.forEach((m, i) => {
      const { symbol, range } = costLabel(m.costTier);
      const rec = m.recommended ? c.green('  ★ recommended') : '';
      console.log(`  ${c.bold(String(i + 1).padStart(2))}. ${m.label}  ${symbol} ${c.dim(range)}${rec}`);
    });
    const modelIdx = parseChoice(await io.nextLine('\nModel number: '), provider.models.length);
    if (modelIdx === null) {
      console.log('No model selected. Nothing changed.');
      return;
    }
    const model = provider.models[modelIdx]!;

    const endpoint = addEndpoint({
      label: `${provider.name} ${model.label}`,
      baseUrl: provider.baseUrl,
      model: model.id,
      kind: provider.kind,
      apiKey,
    });
    console.log(
      `\n${c.green('✓')} Connected ${c.bold(endpoint.label)} ${c.dim(`(${endpoint.id})`)} — key stored in your Keychain.`,
    );

    const isFirst = listEndpoints().length === 1;
    const alreadyDefault = getDefaultEndpoint()?.id === endpoint.id;
    if (isFirst || alreadyDefault) {
      console.log(c.muted('  It is your default model.'));
    } else {
      const ans = (await io.nextLine('Make it your default? [y/N]: ')) ?? '';
      if (/^y(es)?$/i.test(ans.trim())) {
        setDefaultEndpoint(endpoint.id);
        console.log(c.muted('  Set as default.'));
      }
    }
    console.log(`\nTry it:  ${c.bold('northkeep chat')}`);
  } finally {
    io.close();
  }
}

/** Render a throttled text progress bar for an Ollama pull. */
function makeProgressRenderer(): (p: PullProgress) => void {
  let lastDraw = 0;
  let lastPct = -1;
  const width = 24;
  return (p: PullProgress) => {
    const now = Date.now();
    const hasBytes = p.totalBytes !== undefined && p.totalBytes > 0 && p.completedBytes !== undefined;
    const pct = hasBytes ? Math.floor((p.completedBytes! / p.totalBytes!) * 100) : -1;
    // Throttle: redraw at most ~8x/sec, or whenever the phase/percent changes.
    if (now - lastDraw < 120 && pct === lastPct) return;
    lastDraw = now;
    lastPct = pct;
    if (hasBytes) {
      const frac = p.completedBytes! / p.totalBytes!;
      const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
      const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
      const mb = (b: number) => (b / 1024 / 1024).toFixed(0);
      process.stdout.write(
        `\r  [${bar}] ${String(pct).padStart(3)}%  ${p.status} ${DIM}(${mb(p.completedBytes!)}/${mb(p.totalBytes!)} MB)${RESET}   `,
      );
    } else {
      process.stdout.write(`\r  ${p.status} …${' '.repeat(width)}`);
    }
  };
}

/** `northkeep models install [tag]` — 1-click hardware-matched local install. */
export async function modelsInstall(tag: string | undefined): Promise<void> {
  const hw = detectHardware();
  const rec = recommendLocalModel(hw);
  console.log(
    `${c.muted('This Mac')}  ${hw.chip} · ${hw.totalRamGB} GB · ${hw.arch}`,
  );

  let model = tag?.trim();
  if (!model) {
    model = rec.tag;
    console.log(`${c.muted('Recommended')}  ${c.bold(rec.label)} ${c.dim(`(${rec.tag})`)} — ${rec.reason}`);
    const io = createLineReader();
    try {
      const ans = (await io.nextLine(`\nInstall ${c.bold(rec.tag)} now? [Y/n]: `)) ?? '';
      if (/^n(o)?$/i.test(ans.trim())) {
        console.log('Nothing installed.');
        return;
      }
    } finally {
      io.close();
    }
  }

  const state = await ollamaState();
  if (state === 'not-installed') {
    console.log(`\n${c.yellow('Ollama isn\'t installed')} — it's the free local engine that runs models on your Mac.`);
    console.log('  Install it, then re-run this command:');
    console.log(`    ${c.pine('https://ollama.com/download')}`);
    console.log(`    ${c.bold('brew install ollama && brew services start ollama')}`);
    return;
  }

  console.log(`\nDownloading ${c.bold(model)} …`);
  const onProgress = makeProgressRenderer();
  try {
    await createOllamaClient().pull(model, onProgress);
  } catch (err) {
    process.stdout.write('\n');
    throw new Error(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.stdout.write('\n');

  const endpoint = addEndpoint({
    label: `This Mac — ${model}`,
    baseUrl: 'http://127.0.0.1:11434',
    model,
    kind: 'openai-compatible',
  });
  console.log(`${c.green('✓')} Installed and connected ${c.bold(endpoint.label)} ${c.dim(`(${endpoint.id})`)}.`);
  console.log(c.muted('  Runs entirely on your Mac — nothing leaves your machine.'));
  console.log(`\nTry it:  ${c.bold('northkeep chat')}`);
}
