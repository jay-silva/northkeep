import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addEndpoint, EndpointExistsError, listEndpoints } from '../src/settings.js';

/**
 * Endpoint de-duplication: every "add" path (onboarding, the guided wizard, a
 * manual add, a local re-pull) otherwise stacks a redundant pointer at the same
 * model — addEndpoint refuses an exact URL+model duplicate.
 */

let home: string;
const prev = process.env.NORTHKEEP_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-settings-'));
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
});
afterEach(() => {
  if (prev === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('addEndpoint de-duplication', () => {
  it('refuses an exact URL+model duplicate and names the existing one', () => {
    addEndpoint({ label: 'Local llama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2:3b' });
    expect(() =>
      addEndpoint({ label: 'Llama 3B', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2:3b' }),
    ).toThrow(EndpointExistsError);
    expect(listEndpoints()).toHaveLength(1); // the duplicate was not added
  });

  it('matches the model case-insensitively', () => {
    addEndpoint({ label: 'Qwen', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:14b' });
    expect(() =>
      addEndpoint({ label: 'Qwen again', baseUrl: 'http://127.0.0.1:11434', model: 'Qwen2.5:14B' }),
    ).toThrow(EndpointExistsError);
  });

  it('allows the same model on a DIFFERENT endpoint, and different models on the same URL', () => {
    addEndpoint({ label: 'Local A', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2:3b' });
    // Same URL, different model → fine (that's how you run two local models).
    expect(() =>
      addEndpoint({ label: 'Local B', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:14b' }),
    ).not.toThrow();
    expect(listEndpoints()).toHaveLength(2);
  });
});
