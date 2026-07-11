import readline from 'node:readline/promises';
import type { Vault } from '@northkeep/core';
import { createOllamaClient, type OllamaClient } from '@northkeep/librarian';
import {
  TurnError,
  classifyEndpoint,
  createAnthropicProvider,
  createOpenAICompatibleProvider,
  createSession,
  getDefaultEndpoint,
  getEndpoint,
  getEndpointKey,
  listEndpoints,
  loadRoutingPolicy,
  route,
  RouteError,
  runTurn,
  vaultAdapter,
  type EndpointConfig,
  type ModelProvider,
  type PrivacyCeiling,
} from '@northkeep/converse';

/**
 * `northkeep converse` — the mediated client in the terminal (M6, ADR 0007).
 * Every turn: retrieve → redact → call → restore → distill → audit, with the
 * privacy badge and provenance printed where the user can see them.
 */

type WithVault = <T>(fn: (vault: Vault) => Promise<T> | T) => Promise<T>;

const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export function badgeLine(endpoint: EndpointConfig): string {
  const { tier, host, reason } = classifyEndpoint(endpoint.baseUrl);
  return tier === 'private'
    ? `${GREEN}● private${RESET} — nothing leaves your network (${host}: ${reason})`
    : `${YELLOW}● bounded${RESET} — masked before send, audited (${host}: ${reason})`;
}

export function providerFor(endpoint: EndpointConfig): ModelProvider {
  const apiKey = getEndpointKey(endpoint.id) ?? undefined;
  if (endpoint.kind === 'anthropic') {
    if (!apiKey) {
      throw new Error(
        `No API key stored for "${endpoint.label}". Re-add it with: northkeep providers add --api-key-stdin`,
      );
    }
    return createAnthropicProvider({ apiKey, baseUrl: endpoint.baseUrl });
  }
  return createOpenAICompatibleProvider({ baseUrl: endpoint.baseUrl, apiKey });
}

export interface ConverseCmdOptions {
  endpoint?: string;
  tier: string;
  scope: string;
  /** Start with the concierge routing each message (M7b). */
  auto?: boolean;
}

export async function runConverse(options: ConverseCmdOptions, withVault: WithVault): Promise<void> {
  let endpoint = options.endpoint ? getEndpoint(options.endpoint) : getDefaultEndpoint();
  if (!endpoint) {
    throw new Error(
      options.endpoint
        ? `No endpoint "${options.endpoint}". See: northkeep providers list`
        : 'No endpoints configured yet. Add one:\n' +
          '  northkeep providers add --label "Local" --base-url http://127.0.0.1:11434 --model llama3.2:3b',
    );
  }
  const tier = options.tier === '0' ? 0 : options.tier === '2' ? 2 : 1;
  const classification = classifyEndpoint(endpoint.baseUrl);
  if (tier === 0 && classification.tier !== 'private') {
    throw new Error(
      'Redaction cannot be turned off toward a non-private endpoint. Use --tier 1 or --tier 2, or point at a local/LAN model.',
    );
  }
  let auto = options.auto === true;
  let ceiling: PrivacyCeiling = 'bounded-allowed';
  if (auto && tier === 0) {
    // Auto may route any message to a bounded endpoint; "off" is never safe there.
    throw new Error('Redaction tier 0 needs a fixed private endpoint — it cannot ride --auto.');
  }

  let provider = providerFor(endpoint);
  let model = endpoint.model;
  const ollama = createOllamaClient();
  let distillOllama: OllamaClient | null = null;
  try {
    distillOllama = (await ollama.available()) ? ollama : null;
  } catch {
    distillOllama = null;
  }

  console.log(`Converse — ${endpoint.label} (${endpoint.model})`);
  console.log(badgeLine(endpoint));
  console.log(
    `Redaction tier ${tier}${tier === 2 ? ' (secrets masked + names pseudonymized)' : tier === 1 ? ' (secrets masked)' : ' (OFF — private endpoint)'}` +
      ` · memory distillation: ${distillOllama ? 'local model' : 'heuristic (Ollama not running)'}`,
  );
  if (auto) console.log(`${GREEN}✦ Auto${RESET} — the concierge routes each message (":auto" toggles).`);
  console.log(`${DIM}Commands: :auto  :private  :model <name>  :models  :endpoint <label|id>  :endpoints  :undo  :memories  :quit${RESET}\n`);

  const session = createSession();
  const vault = vaultAdapter(withVault);
  let lastCreated: string[] = [];
  let lastUsed: Array<{ id: string; type: string; content: string }> = [];

  // Queue lines instead of rl.question(): while a command awaits something
  // async (e.g. :models hitting the endpoint), readline would silently DROP
  // lines that arrive mid-await — breaking pasted input and piped scripting.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pending: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let stdinClosed = false;
  rl.on('line', (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else pending.push(l);
  });
  rl.on('close', () => {
    stdinClosed = true;
    while (waiters.length) waiters.shift()!(null);
  });
  const nextLine = (promptText: string): Promise<string | null> => {
    if (pending.length > 0) return Promise.resolve(pending.shift()!);
    if (stdinClosed) return Promise.resolve(null);
    process.stdout.write(promptText);
    return new Promise((r) => waiters.push(r));
  };

  for (;;) {
    const line = await nextLine('you> ');
    if (line === null) break; // Ctrl-D / closed input
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === ':quit' || trimmed === ':exit') break;

    // --- concierge (M7b). :auto routes each message; :private pins the chat
    // to local models only — a promise that binds auto AND manual sends.
    if (trimmed === ':auto') {
      if (!auto && tier === 0) {
        console.log('Redaction tier 0 needs a fixed private endpoint — it cannot ride auto.');
        continue;
      }
      auto = !auto;
      console.log(auto
        ? `${GREEN}✦ Auto on${RESET} — each message routes by task${ceiling === 'private-only' ? ' (local models only — pinned)' : ''}.`
        : `Auto off — staying on ${endpoint.label} (${model}).`);
      continue;
    }

    if (trimmed === ':private') {
      ceiling = ceiling === 'private-only' ? 'bounded-allowed' : 'private-only';
      console.log(ceiling === 'private-only'
        ? `${GREEN}● Pinned private${RESET} — nothing in this conversation leaves your machine.`
        : 'Unpinned — hosted endpoints are allowed again (redaction still applies).');
      continue;
    }

    // --- quick-switch (M7a, ADR 0011). Switching mid-conversation is safe by
    // design: history is plaintext and the whole prompt is re-redacted at the
    // CURRENT endpoint's effective tier on every turn.
    if (trimmed === ':model' || trimmed.startsWith(':model ')) {
      const wanted = trimmed.slice(6).trim();
      if (!wanted) {
        console.log(`Current model: ${model}${model !== endpoint.model ? ` (endpoint default: ${endpoint.model})` : ''}`);
        console.log('Switch with ":model <name>" — ":models" lists what this endpoint serves.');
      } else if (!/^[\w.:/-]{1,128}$/.test(wanted) || wanted.includes('..')) {
        console.log('That does not look like a model id.');
      } else {
        model = wanted;
        console.log(`✓ Next turns use ${model} on ${endpoint.label}.`);
      }
      continue;
    }

    if (trimmed === ':models') {
      try {
        const models = await provider.listModels();
        if (models.length === 0) console.log('The endpoint reported no models.');
        for (const m of models) console.log(`  ${m}${m === model ? '  ← current' : m === endpoint.model ? '  (endpoint default)' : ''}`);
      } catch {
        console.log('Could not list models — is the endpoint running? (":model <name>" still works.)');
      }
      continue;
    }

    if (trimmed === ':endpoints') {
      for (const ep of listEndpoints()) {
        const { tier: epTier } = classifyEndpoint(ep.baseUrl);
        console.log(`  ${ep.id === endpoint.id ? '→' : ' '} ${ep.label}  ${DIM}${ep.id} · ${ep.model} · ${epTier}${RESET}`);
      }
      continue;
    }

    if (trimmed === ':endpoint' || trimmed.startsWith(':endpoint ')) {
      const wanted = trimmed.slice(9).trim();
      if (!wanted) {
        console.log(`Current endpoint: ${endpoint.label} (${endpoint.id}). ":endpoints" lists all.`);
        continue;
      }
      const all = listEndpoints();
      const next =
        all.find((ep) => ep.id === wanted) ??
        all.find((ep) => ep.label.toLowerCase() === wanted.toLowerCase());
      if (!next) {
        console.log(`No endpoint "${wanted}". ":endpoints" lists all.`);
        continue;
      }
      // The tier-0 guard from startup applies to the NEW endpoint too: with
      // redaction off, the conversation may only ever face private endpoints.
      if (tier === 0 && classifyEndpoint(next.baseUrl).tier !== 'private') {
        console.log(`${RED}✗ Not switching:${RESET} redaction is OFF (--tier 0) and "${next.label}" is not private. Restart with --tier 1 or 2 to use it.`);
        continue;
      }
      // So does the privacy pin — the promise binds manual switches too.
      if (ceiling === 'private-only' && classifyEndpoint(next.baseUrl).tier !== 'private') {
        console.log(`${RED}✗ Not switching:${RESET} this conversation is pinned private and "${next.label}" would leave the machine. ":private" unpins.`);
        continue;
      }
      try {
        provider = providerFor(next); // may throw (e.g. missing API key)
      } catch (err) {
        console.log(`✗ ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      endpoint = next;
      model = next.model;
      console.log(`✓ Switched to ${endpoint.label} (${model}). Your conversation and memory come along.`);
      console.log(badgeLine(endpoint));
      continue;
    }

    if (trimmed === ':undo') {
      if (lastCreated.length === 0) {
        console.log('Nothing to undo from the last turn.');
        continue;
      }
      const ids = lastCreated;
      await withVault((v) => {
        for (const id of ids) {
          try {
            v.forget(id);
          } catch {
            // already forgotten — undo is best-effort per id
          }
        }
        v.save();
      });
      console.log(`✓ Forgot ${ids.length} memor${ids.length === 1 ? 'y' : 'ies'} from the last turn.`);
      lastCreated = [];
      continue;
    }

    if (trimmed === ':memories') {
      if (lastUsed.length === 0) {
        console.log('The last turn used no memories.');
      } else {
        for (const m of lastUsed) console.log(`  [${m.type}] ${m.id.slice(0, 8)}  ${m.content}`);
      }
      continue;
    }

    // Resolve where THIS turn goes: the concierge under :auto, else the
    // current endpoint — with the privacy pin enforced on both paths.
    let turnProvider = provider;
    let turnModel = model;
    let routeReason: string | undefined;
    if (auto) {
      try {
        const decision = route({
          message: trimmed,
          endpoints: listEndpoints(),
          policy: loadRoutingPolicy(),
          ceiling,
          defaultEndpointId: endpoint.id,
        });
        const chosen = getEndpoint(decision.endpointId);
        if (!chosen) throw new RouteError('The routed endpoint disappeared — check :endpoints.');
        turnProvider = providerFor(chosen); // may throw (e.g. missing API key)
        turnModel = decision.model;
        routeReason = decision.reason;
      } catch (err) {
        console.log(`✗ ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    } else if (ceiling === 'private-only' && classifyEndpoint(endpoint.baseUrl).tier !== 'private') {
      console.log(`${RED}✗ Nothing sent:${RESET} this conversation is pinned private and ${endpoint.label} would leave the machine. ":private" unpins, or ":endpoint" a local model.`);
      continue;
    }

    let streamed = '';
    try {
      const result = await runTurn({
        message: trimmed,
        session,
        provider: turnProvider,
        model: turnModel,
        routeReason,
        vault,
        redactTier: tier,
        memoryScope: options.scope,
        distillOllama,
        onToken: (token) => {
          streamed += token;
          process.stdout.write(token);
        },
      });
      process.stdout.write('\n');
      if (result.reply !== streamed) {
        console.log(`${DIM}— restored —${RESET}`);
        console.log(result.reply);
      }
      lastCreated = result.memoriesCreated.map((m) => m.id);
      lastUsed = result.memoriesUsed;
      console.log(
        `${DIM}[${result.privacy} · ${result.endpointHost} · ${result.model} · tier ${result.tierApplied}` +
          `${result.tier2Degraded ? ' (tier 2 degraded)' : ''}` +
          ` · memory: ${result.memoriesUsed.length} used, ${result.memoriesCreated.length} added]${RESET}`,
      );
      if (routeReason) console.log(`${DIM}[✦ ${routeReason}]${RESET}`);
      for (const m of result.memoriesCreated) console.log(`  ${DIM}+ [${m.type}] ${m.content}${RESET}`);
      if (result.memoriesCreated.length > 0) console.log(`  ${DIM}(:undo to remove them)${RESET}`);
    } catch (err) {
      if (err instanceof TurnError && err.code === 'TIER2_UNAVAILABLE') {
        console.error(`\n${RED}✗ NOTHING WAS SENT.${RESET} ${err.message}`);
      } else {
        console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  rl.close();
  console.log('Bye.');
}
