import {
  classifyEndpoint,
  listEndpoints,
  loadRoutingPolicy,
  routingPath,
  saveRoutingPolicy,
  type RoutingRule,
  type TaskKind,
} from '@northkeep/converse';

/**
 * `northkeep routing` — the concierge's rule book (M7b, ADR 0011). Rules map
 * a task kind to an endpoint (optionally a specific model). No rule ⇒ the
 * default endpoint. Rules never override the privacy ceiling: a pinned-private
 * conversation skips any rule pointing off the machine.
 */

const TASKS: ReadonlyArray<TaskKind | '*'> = [
  'code',
  'reasoning',
  'creative',
  'long-context',
  'quick',
  'general',
  '*',
];

export function routingList(): void {
  const { rules } = loadRoutingPolicy();
  if (rules.length === 0) {
    console.log('No routing rules — Auto uses your default endpoint for everything.');
    console.log('Add one: northkeep routing set <task> <endpoint> [--model <m>]');
    console.log(`Tasks: ${TASKS.join(', ')}`);
    return;
  }
  const endpoints = new Map(listEndpoints().map((e) => [e.id, e]));
  for (const r of rules) {
    const ep = endpoints.get(r.endpointId);
    const where = ep
      ? `${ep.label} (${classifyEndpoint(ep.baseUrl).tier})`
      : `${r.endpointId} — MISSING (rule is ignored)`;
    console.log(`  ${r.task.padEnd(12)} → ${where}${r.model ? ` · ${r.model}` : ''}`);
  }
  console.log(`\nStored in ${routingPath()} (rules only — no secrets, no content).`);
}

export function routingSet(
  task: string,
  endpointRef: string,
  options: { model?: string },
  fail: (m: string) => never,
): void {
  if (!TASKS.includes(task as TaskKind | '*')) {
    fail(`Unknown task "${task}". Tasks: ${TASKS.join(', ')}`);
  }
  const all = listEndpoints();
  const endpoint =
    all.find((e) => e.id === endpointRef) ??
    all.find((e) => e.label.toLowerCase() === endpointRef.toLowerCase());
  if (!endpoint) fail(`No endpoint "${endpointRef}". See: northkeep providers list`);
  const policy = loadRoutingPolicy();
  const rule: RoutingRule = {
    task: task as TaskKind | '*',
    endpointId: endpoint.id,
    ...(options.model ? { model: options.model } : {}),
  };
  const existing = policy.rules.findIndex((r) => r.task === rule.task);
  if (existing >= 0) policy.rules[existing] = rule;
  else policy.rules.push(rule);
  saveRoutingPolicy(policy);
  const tier = classifyEndpoint(endpoint.baseUrl).tier;
  console.log(`✓ ${task} → ${endpoint.label}${options.model ? ` · ${options.model}` : ''} (${tier})`);
  if (tier !== 'private') {
    console.log('  Note: a conversation pinned private will skip this rule and stay local.');
  }
}

export function routingClear(task: string | undefined, fail: (m: string) => never): void {
  const policy = loadRoutingPolicy();
  if (!task) {
    saveRoutingPolicy({ rules: [] });
    console.log('✓ Cleared all routing rules.');
    return;
  }
  const before = policy.rules.length;
  policy.rules = policy.rules.filter((r) => r.task !== task);
  if (policy.rules.length === before) fail(`No rule for task "${task}".`);
  saveRoutingPolicy(policy);
  console.log(`✓ Cleared the ${task} rule.`);
}
