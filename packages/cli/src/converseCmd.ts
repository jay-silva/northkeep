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
  runTurn,
  vaultAdapter,
  type EndpointConfig,
  type ModelProvider,
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
}

export async function runConverse(options: ConverseCmdOptions, withVault: WithVault): Promise<void> {
  const endpoint = options.endpoint ? getEndpoint(options.endpoint) : getDefaultEndpoint();
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

  const provider = providerFor(endpoint);
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
  console.log(`${DIM}Commands: :undo  :memories  :quit${RESET}\n`);

  const session = createSession();
  const vault = vaultAdapter(withVault);
  let lastCreated: string[] = [];
  let lastUsed: Array<{ id: string; type: string; content: string }> = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    let line: string;
    try {
      line = await rl.question('you> ');
    } catch {
      break; // Ctrl-D / closed input
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === ':quit' || trimmed === ':exit') break;

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

    let streamed = '';
    try {
      const result = await runTurn({
        message: trimmed,
        session,
        provider,
        model: endpoint.model,
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
