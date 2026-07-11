import { describe, expect, it } from 'vitest';
import { classifyTask, route, RouteError, type RoutePolicy } from '../src/route.js';
import type { EndpointConfig } from '../src/settings.js';

/**
 * route() unit tests (M7b, ADR 0011). The load-bearing property: routing may
 * NEVER pick an endpoint above the conversation's privacy ceiling — not via a
 * rule, not via the default, not via the last-resort scan.
 */

const ep = (id: string, baseUrl: string, model = `${id}-model`): EndpointConfig => ({
  id,
  label: id,
  baseUrl,
  model,
  kind: 'openai-compatible',
  hasKey: false,
});

const LOCAL = ep('local', 'http://127.0.0.1:11434');
const CLOUD = ep('cloud', 'https://api.example.com');
const endpoints = [LOCAL, CLOUD];
const noRules: RoutePolicy = { rules: [] };

describe('classifyTask', () => {
  it('spots code', () => {
    expect(classifyTask('Why does this throw?\n```js\nconst x = 1\n```')).toBe('code');
    expect(classifyTask('debug this python stack trace for me')).toBe('code');
  });
  it('spots long-context / summarize', () => {
    expect(classifyTask('Summarize the key points of this document.')).toBe('long-context');
    expect(classifyTask('x'.repeat(7000))).toBe('long-context');
  });
  it('spots creative', () => {
    expect(classifyTask('Write a short story about a lighthouse keeper')).toBe('creative');
  });
  it('spots reasoning', () => {
    expect(classifyTask('Compare the trade-offs of buying vs renting for us')).toBe('reasoning');
  });
  it('short questions are quick; everything else general', () => {
    expect(classifyTask('What time zone is Boston in?')).toBe('quick');
    expect(classifyTask('Tell me about the harbor at length and in detail with no particular structure')).toBe('general');
  });
});

describe('route — rules and defaults', () => {
  it('routes by the first matching task rule, with its model override', () => {
    const d = route({
      message: 'fix this ```code```',
      endpoints,
      policy: { rules: [{ task: 'code', endpointId: 'cloud', model: 'big-coder' }] },
      ceiling: 'bounded-allowed',
      defaultEndpointId: 'local',
    });
    expect(d).toMatchObject({ endpointId: 'cloud', model: 'big-coder', task: 'code' });
    expect(d.reason).toContain('rule');
  });

  it('exact-task rules beat catch-all rules regardless of order', () => {
    const d = route({
      message: 'fix this ```code```',
      endpoints,
      policy: {
        rules: [
          { task: '*', endpointId: 'local' },
          { task: 'code', endpointId: 'cloud' },
        ],
      },
      ceiling: 'bounded-allowed',
      defaultEndpointId: 'local',
    });
    expect(d.endpointId).toBe('cloud');
  });

  it('falls back to the default endpoint when no rule matches', () => {
    const d = route({
      message: 'hello there friend',
      endpoints,
      policy: noRules,
      ceiling: 'bounded-allowed',
      defaultEndpointId: 'cloud',
    });
    expect(d.endpointId).toBe('cloud');
    expect(d.reason).toContain('default');
  });

  it('ignores rules that point at removed endpoints', () => {
    const d = route({
      message: 'hello there friend',
      endpoints,
      policy: { rules: [{ task: '*', endpointId: 'gone' }] },
      ceiling: 'bounded-allowed',
      defaultEndpointId: 'local',
    });
    expect(d.endpointId).toBe('local');
  });
});

describe('route — the privacy ceiling (NEVER silently escalate)', () => {
  it('a private-only chat skips a rule pointing at a bounded endpoint — and says so', () => {
    const d = route({
      message: 'fix this ```code```',
      endpoints,
      policy: { rules: [{ task: 'code', endpointId: 'cloud' }] },
      ceiling: 'private-only',
      defaultEndpointId: 'local',
    });
    expect(d.endpointId).toBe('local'); // stayed home
    expect(d.reason).toContain('skipped cloud');
    expect(d.reason).toContain('privacy ceiling');
  });

  it('a private-only chat skips a bounded DEFAULT and lands on any private endpoint', () => {
    const d = route({
      message: 'hello there friend',
      endpoints,
      policy: noRules,
      ceiling: 'private-only',
      defaultEndpointId: 'cloud',
    });
    expect(d.endpointId).toBe('local');
  });

  it('exhaustive: over every rule/default combination, private-only NEVER yields a bounded endpoint', () => {
    const tasks = ['code', 'reasoning', 'creative', 'long-context', 'quick', 'general', '*'] as const;
    for (const task of tasks) {
      for (const target of ['local', 'cloud']) {
        for (const def of ['local', 'cloud', null]) {
          const d = route({
            message: 'fix this ```code``` and also summarize why, write a story?',
            endpoints,
            policy: { rules: [{ task, endpointId: target }] },
            ceiling: 'private-only',
            defaultEndpointId: def,
          });
          expect(d.endpointId, `task=${task} target=${target} default=${def}`).toBe('local');
        }
      }
    }
  });

  it('private-only with NO private endpoints refuses loudly instead of escalating', () => {
    expect(() =>
      route({
        message: 'hi?',
        endpoints: [CLOUD],
        policy: noRules,
        ceiling: 'private-only',
        defaultEndpointId: 'cloud',
      }),
    ).toThrow(RouteError);
  });

  it('bounded-allowed uses bounded endpoints normally', () => {
    const d = route({
      message: 'hi there?',
      endpoints: [CLOUD],
      policy: noRules,
      ceiling: 'bounded-allowed',
      defaultEndpointId: 'cloud',
    });
    expect(d.endpointId).toBe('cloud');
  });
});
