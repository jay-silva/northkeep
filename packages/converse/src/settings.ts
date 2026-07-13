import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';
import { keychainAvailable } from '@northkeep/mcp-server';
import { normalizeBaseUrl } from './openai.js';
import { classifyEndpoint } from './provider.js';

/**
 * Endpoint configuration (ADR 0008). The config file holds WHERE to call —
 * base URL, model, label. It NEVER holds API keys: keys go to the macOS
 * Keychain (same posture as the vault master key, ADR 0002), keyed by
 * endpoint id. `hasKey` is the only trace a key leaves in the file.
 */

export interface EndpointConfig {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  kind: 'openai-compatible' | 'anthropic';
  hasKey: boolean;
}

interface ProvidersFile {
  endpoints: EndpointConfig[];
  defaultId?: string;
}

export function providersPath(): string {
  return path.join(northkeepHome(), 'providers.json');
}

export function listEndpoints(): EndpointConfig[] {
  return load().endpoints;
}

export function getEndpoint(id: string): EndpointConfig | null {
  return load().endpoints.find((e) => e.id === id) ?? null;
}

export function getDefaultEndpoint(): EndpointConfig | null {
  const file = load();
  if (file.endpoints.length === 0) return null;
  return file.endpoints.find((e) => e.id === file.defaultId) ?? file.endpoints[0] ?? null;
}

export function setDefaultEndpoint(id: string): void {
  const file = load();
  if (!file.endpoints.some((e) => e.id === id)) throw new Error(`No endpoint "${id}".`);
  file.defaultId = id;
  save(file);
}

export interface AddEndpointInput {
  label: string;
  baseUrl: string;
  model: string;
  kind?: 'openai-compatible' | 'anthropic';
  apiKey?: string;
}

/** Thrown by addEndpoint when an endpoint with the same URL + model exists. */
export class EndpointExistsError extends Error {
  constructor(
    message: string,
    readonly existing: EndpointConfig,
  ) {
    super(message);
    this.name = 'EndpointExistsError';
  }
}

export function addEndpoint(input: AddEndpointInput): EndpointConfig {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const { tier } = classifyEndpoint(baseUrl); // validates the URL shape too
  const hasKey = input.apiKey !== undefined && input.apiKey.length > 0;
  if (hasKey && tier === 'bounded' && new URL(baseUrl).protocol !== 'https:') {
    throw new Error(
      'Refusing to store an API key for a plain-http public endpoint — the key would cross the network unencrypted. Use https.',
    );
  }
  const file = load();
  // Refuse an exact duplicate (same URL + model): every "add" path — onboarding,
  // the guided wizard, a manual add, a re-pull — otherwise stacks a redundant
  // pointer at the same model. Case-insensitive model match ("Qwen2.5:14B").
  const dup = file.endpoints.find(
    (e) => e.baseUrl === baseUrl && e.model.toLowerCase() === input.model.toLowerCase(),
  );
  if (dup) {
    throw new EndpointExistsError(
      `"${dup.label}" already points at ${input.model} on ${baseUrl}.`,
      dup,
    );
  }
  const id = makeId(input.label);
  const endpoint: EndpointConfig = {
    id,
    label: input.label.trim(),
    baseUrl,
    model: input.model,
    kind: input.kind ?? 'openai-compatible',
    hasKey,
  };
  file.endpoints.push(endpoint);
  if (hasKey) setEndpointKey(id, input.apiKey as string);
  save(file); // after the key is stored, so hasKey never lies about a lost key
  return endpoint;
}

export function removeEndpoint(id: string): boolean {
  const file = load();
  const before = file.endpoints.length;
  file.endpoints = file.endpoints.filter((e) => e.id !== id);
  if (file.endpoints.length === before) return false;
  if (file.defaultId === id) delete file.defaultId;
  deleteEndpointKey(id);
  save(file);
  return true;
}

// --- API keys: Keychain, with an env escape hatch for tests/non-macOS ---

const KEY_SERVICE = 'northkeep-provider-key';

function keyEnvVar(id: string): string {
  return `NORTHKEEP_PROVIDER_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Resolve an endpoint's API key. Env (tests/scripting) → Keychain → null. */
export function getEndpointKey(id: string): string | null {
  const fromEnv = process.env[keyEnvVar(id)];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (!keychainAvailable()) return null;
  try {
    const key = execFileSync(
      'security',
      ['find-generic-password', '-s', KEY_SERVICE, '-a', id, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export function setEndpointKey(id: string, apiKey: string): void {
  if (/[\n\r]/.test(apiKey)) throw new Error('Malformed API key.');
  if (!keychainAvailable()) {
    throw new Error(
      `No Keychain available on this system. For scripting/tests, pass the key via the ${keyEnvVar(id)} environment variable instead — NorthKeep never writes API keys to files.`,
    );
  }
  // security -i takes commands on stdin so the key never hits a command
  // line where `ps` could read it (same pattern as the master key).
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${KEY_SERVICE} -a ${id} -w ${shellQuote(apiKey)}\n`,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

export function deleteEndpointKey(id: string): void {
  if (!keychainAvailable()) return;
  try {
    execFileSync('security', ['delete-generic-password', '-s', KEY_SERVICE, '-a', id], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // not present — fine
  }
}

// --- internals ---

function load(): ProvidersFile {
  try {
    const raw = fs.readFileSync(providersPath(), 'utf8');
    const parsed = JSON.parse(raw) as ProvidersFile;
    if (!Array.isArray(parsed.endpoints)) return { endpoints: [] };
    return parsed;
  } catch {
    return { endpoints: [] };
  }
}

function save(file: ProvidersFile): void {
  const target = providersPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

function makeId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const suffix = crypto.randomBytes(3).toString('hex');
  return slug.length > 0 ? `${slug}-${suffix}` : suffix;
}

/** Quote a value for the `security -i` command line (stdin mini-shell). */
function shellQuote(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}
