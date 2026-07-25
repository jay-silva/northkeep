import readline from 'node:readline/promises';
import { DIM, GREEN, YELLOW, RED, RESET, createSpinner } from './ui.js';
import { collectMcpToolsForCli } from './mcpCmd.js';
import type { Vault } from '@northkeep/core';
import { createOllamaClient, type OllamaClient } from '@northkeep/librarian';
import {
  TurnError,
  classifyEndpoint,
  createAnthropicProvider,
  createOpenAICompatibleProvider,
  createPermissionEngine,
  createSession,
  enabledTools,
  getDefaultEndpoint,
  getEndpoint,
  getEndpointKey,
  listEndpoints,
  loadRoutingPolicy,
  route,
  RouteError,
  runTask,
  runTurn,
  suggestBetterModel,
  vaultAdapter,
  type EndpointConfig,
  type ModelProvider,
  type PrivacyCeiling,
  type TaskEvent,
  type TaskHooks,
  type TaskResult,
  type ToolDefinition,
  type TurnOptions,
  type TurnResult,
} from '@northkeep/converse';

/**
 * `northkeep converse` — the mediated client in the terminal (M6, ADR 0007).
 * Every turn: retrieve → redact → call → restore → distill → audit, with the
 * privacy badge and provenance printed where the user can see them.
 */

type WithVault = <T>(fn: (vault: Vault) => Promise<T> | T) => Promise<T>;


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
  /** Opt IN to agent tools (M10b): registry-enabled tools ride each turn via
   * runTask. Without the flag, exactly the old runTurn path — v1 conservative. */
  tools?: boolean;
}

const fmtKb = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

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

  // --tools (M10b): opt-in agent tools, gated twice — the flag AND the
  // registry (~/.northkeep/tools.json). Nothing enabled → say so and refuse
  // rather than silently running a plain chat the user thought had tools.
  let taskTools: ToolDefinition[] = [];
  let closeMcp: (() => Promise<void>) | null = null;
  if (options.tools === true) {
    taskTools = enabledTools();
    // M11 (ADR 0033): configured MCP servers contribute their tools too,
    // namespaced <server>__<tool>. A server that fails identity or pin checks
    // is reported by collectMcpTools and skipped — never silently dropped.
    const mcp = await collectMcpToolsForCli();
    closeMcp = mcp.close;
    taskTools = [...taskTools, ...mcp.tools];
    if (taskTools.length === 0) {
      await closeMcp();
      throw new Error(
        'No tools are enabled. Enable a web tool:\n  northkeep tools enable web_fetch\n' +
          'or add an MCP server:\n  northkeep mcp add <id> --command <absolute path>\n' +
          'Then re-run: northkeep converse --tools',
      );
    }
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
  if (taskTools.length > 0) {
    console.log(
      `${YELLOW}⚒ Tools${RESET} — ${taskTools.map((t) => t.name).join(', ')} available; calls ask for your approval (site grants are remembered — "northkeep tools grants" lists, "revoke" undoes).`,
    );
  }
  console.log(`${DIM}Commands: :auto  :private  :model <name>  :models  :endpoint <label|id>  :endpoints  :undo  :memories  :quit${RESET}\n`);

  const session = createSession();
  const vault = vaultAdapter(withVault);
  // The ADR-0029 permission engine, ONE instance for the whole REPL run so
  // session grants live exactly as long as the conversation window. persist:
  // true is the CLI's explicit opt-in to ~/.northkeep/permissions.json.
  const permissionEngine = createPermissionEngine({ persist: true });
  let lastCreated: string[] = [];
  let lastUsed: Array<{ id: string; type: string; content: string }> = [];
  // M9d: the last concierge tip we surfaced, so we don't nag it every turn.
  let lastTip: string | null = null;

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
    // Stdio MCP servers are child processes; leaving them running after the
    // REPL exits would strand them holding a vault handle.
    void closeMcp?.();
    while (waiters.length) waiters.shift()!(null);
  });
  const nextLine = (promptText: string): Promise<string | null> => {
    if (pending.length > 0) return Promise.resolve(pending.shift()!);
    if (stdinClosed) return Promise.resolve(null);
    process.stdout.write(promptText);
    return new Promise((r) => waiters.push(r));
  };

  // The spinner fills every silent wait: after send until the first token,
  // and between agent steps while a tool runs or the model plans. It must be
  // stopped before ANY other output (tokens, events, prompts) or the \r
  // clearing would eat that output's line.
  const spinner = createSpinner();

  // Agent-loop hooks (M10b/M10c): dim one-line progress renders, and approval
  // via the same line queue the REPL uses (pasted input keeps working). The
  // ADR-0029 engine behind runTask honors scoped answers; anything
  // unrecognized (including EOF and the 5-minute timeout inside runTask)
  // denies — fail closed.
  const taskHooks: TaskHooks = {
    onEvent: (e: TaskEvent) => {
      spinner.stop();
      if (e.type === 'step' && e.n > 1) {
        process.stdout.write(`\n${DIM}↳ step ${e.n}${RESET}\n`);
      } else if (e.type === 'tool_call') {
        console.log(
          `\n${DIM}↳ ${e.name} ${e.host ?? ''}${e.egressTier ? ` · ${e.egressTier}` : ''}${RESET}`,
        );
      } else if (e.type === 'permission') {
        // Provenance is rendered honestly (ADR 0029 decision 4): the user
        // must be able to tell a grant-based auto-allow from their own yes,
        // and a screen block must say WHY (content-free reasons).
        if (e.decision === 'approved' && e.via === 'grant') {
          console.log(`${DIM}↳ ✓ ${e.name} auto-allowed (site grant — "northkeep tools revoke" undoes)${RESET}`);
        } else if (e.decision !== 'approved' && e.via === 'screen') {
          console.log(`${RED}↳ ✗ ${e.name} blocked by the exfiltration screen:${RESET}`);
          for (const reason of e.reasons ?? []) console.log(`${RED}    ⚠ ${reason}${RESET}`);
        } else if (e.decision !== 'approved' && e.via === 'grant') {
          console.log(`${DIM}↳ ✗ ${e.name} refused (never-for-this-site grant)${RESET}`);
        } else if (e.decision !== 'approved' && e.via === 'budget') {
          console.log(`${YELLOW}↳ ✗ ${e.name} skipped — ${(e.reasons ?? []).join('; ')} ("northkeep tools budget" to raise)${RESET}`);
        } else if (e.decision !== 'approved') {
          console.log(`${DIM}↳ ✗ ${e.name} ${e.decision === 'timeout' ? 'timed out — denied' : 'denied'}${RESET}`);
        }
      } else if (e.type === 'tool_result') {
        console.log(
          e.ok
            ? `${DIM}↳ ✓ ${fmtKb(e.bytes)} from ${e.host ?? e.name}${e.truncated ? ' (truncated)' : ''}${RESET}`
            : `${YELLOW}↳ ✗ ${e.name}: ${e.error ?? 'returned an error'}${RESET}`,
        );
      }
      // Waiting resumes after everything except tool_call, where the approval
      // prompt is about to take the line: an approved tool is now executing;
      // after a result/denial/new step the model is thinking again.
      if (e.type !== 'tool_call') spinner.start();
    },
    requestApproval: async (req) => {
      spinner.stop();
      // Show the EXACT restored plaintext that would execute (ADR 0027):
      // web_fetch shows the URL; web_search shows the QUERY (never the raw
      // Brave API URL, which is noise and must never carry the token, ADR
      // 0030); anything else shows the raw arguments.
      let url: string | null = null;
      let query: string | null = null;
      try {
        const parsed = JSON.parse(req.argsPlain) as { url?: unknown; query?: unknown };
        if (typeof parsed.url === 'string') url = parsed.url;
        if (typeof parsed.query === 'string') query = parsed.query;
      } catch {
        url = null;
      }
      // Exfil-screen warnings render loudly ABOVE the question — a screened
      // call never auto-allows, and the human deciding must see why.
      for (const w of req.warnings) console.log(`${YELLOW}⚠ ${w}${RESET}`);
      const what =
        req.tool === 'web_fetch' && url !== null
          ? `Allow web_fetch of ${url}?`
          : req.tool === 'web_search' && query !== null
            ? `Allow web_search for "${query}"?`
            : `Allow ${req.tool} with ${req.argsPlain}?`;
      // Site-scoped answers exist only for read-only calls with a concrete
      // host and no screen warnings; everything else is yes-once/no (a
      // consequential call and a flagged call must be seen every time).
      // ADR 0033 Decision 4: a remembered ALLOW needs a subject to key on and
      // is only offered for a clean safe-read call, but a remembered NO is
      // offered for EVERY call with a subject — remembering "yes" to an
      // irreversible action is how approval fatigue becomes data loss, while
      // remembering "no" can only ever narrow what runs.
      const hasSubject = req.egress !== null || req.server !== undefined;
      const offerScopes = hasSubject && req.risk === 'safe-read' && req.warnings.length === 0;
      const offerNever = hasSubject;
      // What a remembered answer would apply to: a host for a web tool, the
      // configured server for an MCP tool.
      const site = req.egress?.host ?? (req.server !== undefined ? `mcp:${req.server}` : '');
      const options = offerScopes
        ? `[y]es once / [s] yes this session for ${site} / [a]lways for ${site} / [n]o / ne[v]er for ${site}`
        : offerNever
          ? `[y]es once / [n]o / ne[v]er for ${site}`
          : '[y]es once / [n]o';
      const answer = (await nextLine(`${what} ${options}: `))?.trim().toLowerCase() ?? '';
      if (/^y(es)?$/.test(answer)) return 'allow';
      if (offerScopes && /^s(ession)?$/.test(answer)) return 'allow-session';
      if (offerScopes && /^a(lways)?$/.test(answer)) return 'allow-always';
      if (offerNever && /^(v|never)$/.test(answer)) return 'deny-never';
      return 'deny'; // fail closed: EOF, typos, anything else
    },
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
        // Re-check the ceiling on the OBJECT WE ACTUALLY USE: route() classified
        // a snapshot; getEndpoint() re-read the config file. If the baseUrl
        // changed in between, the pin must still hold (adversarial review M-1).
        if (ceiling === 'private-only' && classifyEndpoint(chosen.baseUrl).tier !== 'private') {
          throw new RouteError(`"${chosen.label}" is no longer private — not sending (pinned).`);
        }
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
      const turnArgs: TurnOptions = {
        message: trimmed,
        session,
        provider: turnProvider,
        model: turnModel,
        ...(routeReason !== undefined ? { routeReason } : {}),
        vault,
        redactTier: tier,
        memoryScope: options.scope,
        distillOllama,
        onToken: (token: string) => {
          spinner.stop();
          streamed += token;
          process.stdout.write(token);
        },
      };
      spinner.start();
      // --tools rides runTask (the agent loop, M10b); otherwise EXACTLY the
      // old runTurn path — byte-for-byte the same behavior without the flag.
      let taskResult: TaskResult | null = null;
      let result: TurnResult;
      if (taskTools.length > 0) {
        // Ctrl-C cancels the RUNNING TASK rather than killing the REPL: the
        // loop's own abort path denies any pending approval and appends
        // "Cancelled by the user." (task.ts). Without this the CLI passed no
        // signal at all, so a mid-task Ctrl-C could only kill the process —
        // and KNOWN-LIMITS claimed otherwise. The listener is scoped to the
        // task and removed in `finally`, so it can never accumulate across
        // turns or swallow Ctrl-C at the prompt.
        const controller = new AbortController();
        const onSigint = (): void => {
          spinner.stop();
          console.log(`\n${YELLOW}[cancelling…]${RESET}`);
          controller.abort();
        };
        process.on('SIGINT', onSigint);
        try {
          taskResult = await runTask({
            ...turnArgs,
            tools: taskTools,
            hooks: taskHooks,
            gate: permissionEngine,
            signal: controller.signal,
          });
        } finally {
          process.off('SIGINT', onSigint);
        }
        result = taskResult;
      } else {
        result = await runTurn(turnArgs);
      }
      spinner.stop();
      process.stdout.write('\n');
      if (taskResult?.stopped === 'step-limit') {
        console.log(`${YELLOW}[stopped: step limit]${RESET}`);
      }
      if (result.reply !== streamed) {
        console.log(`${DIM}— restored —${RESET}`);
        console.log(result.reply);
      }
      lastCreated = result.memoriesCreated.map((m) => m.id);
      lastUsed = result.memoriesUsed;
      // Approximate, on-device cost of this turn (token counts × catalog prices).
      const c = result.cost;
      const costSeg = c
        ? c.usd > 0
          ? ` · ≈$${c.usd < 0.01 ? c.usd.toFixed(4) : c.usd.toFixed(2)}`
          : ' · free (local)'
        : '';
      console.log(
        `${DIM}[${result.privacy} · ${result.endpointHost} · ${result.model} · tier ${result.tierApplied}` +
          `${result.tier2Degraded ? ' (tier 2 degraded)' : ''}${costSeg}` +
          ` · memory: ${result.memoriesUsed.length} used, ${result.memoriesCreated.length} added]${RESET}`,
      );
      if (routeReason) console.log(`${DIM}[✦ ${routeReason}]${RESET}`);
      if (taskResult !== null && taskResult.toolCallsMade.length > 0) {
        console.log(
          `${DIM}[⚒ ${taskResult.steps} step${taskResult.steps === 1 ? '' : 's'} · ` +
            taskResult.toolCallsMade
              .map((tc) => `${tc.name}${tc.host ? ` ${tc.host}` : ''} (${tc.decision})`)
              .join(', ') +
            `]${RESET}`,
        );
      }
      for (const m of result.memoriesCreated) console.log(`  ${DIM}+ [${m.type}] ${m.content}${RESET}`);
      if (result.memoriesCreated.length > 0) console.log(`  ${DIM}(:undo to remove them)${RESET}`);
      // M9d concierge: if the catalog's strongest model for this task isn't
      // among the connected endpoints, surface a subtle one-liner — but only
      // when the suggestion changes, never nagging the same tip every turn.
      try {
        const tip = suggestBetterModel(trimmed, listEndpoints());
        if (tip && tip.reason !== lastTip) {
          console.log(`${DIM}✦ tip: ${tip.reason}${RESET}`);
          lastTip = tip.reason;
        } else if (!tip) {
          lastTip = null;
        }
      } catch {
        // suggestions are best-effort; never let one break a turn.
      }
    } catch (err) {
      spinner.stop();
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
