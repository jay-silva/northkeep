import { describe, expect, it } from 'vitest';
import { decideMobileRoute } from '../src/lib/route-mobile';
import { ON_DEVICE_PROVIDER_ID, type ProviderMeta } from '../src/lib/provider-ids';

/**
 * The phone concierge (M12). The behaviour that matters most here is a
 * NEGATIVE one: choosing the on-device model must never cause a turn to leave
 * the phone without the user saying so (ADR 0011's privacy ceiling).
 */

const claude: ProviderMeta = {
  id: 'p1',
  label: 'Claude',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-4-8',
} as ProviderMeta;

const ollama: ProviderMeta = {
  id: 'p2',
  label: 'Mac Ollama',
  kind: 'openai',
  baseUrl: 'http://192.168.1.10:11434',
  model: 'qwen2.5:14b',
} as ProviderMeta;

const withKeys = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('the phone never escalates a private turn on its own', () => {
  it('OFFERS a cloud provider for a hard question, and does not send', () => {
    const r = decideMobileRoute({
      message: 'Why should we compare these two vendors and what are the trade-offs?',
      selectedId: ON_DEVICE_PROVIDER_ID,
      providers: [claude],
      usableIds: withKeys('p1'),
    });
    // The user picked on-device, so nothing may leave without a tap.
    expect(r.mode).toBe('offer-cloud');
    expect(r.task).toBe('reasoning');
    expect(r.offer?.label).toBe('Claude');
    // The offer must say plainly that it would leave the phone.
    expect(r.reason).toContain('leave your phone');
  });

  it('answers a memory-shaped question on-device without asking anything', () => {
    for (const message of [
      'what do I know about Morgan St?',
      'remind me what I said about the blender',
    ]) {
      const r = decideMobileRoute({
        message,
        selectedId: ON_DEVICE_PROVIDER_ID,
        providers: [claude],
        usableIds: withKeys('p1'),
      });
      expect(r.mode, message).toBe('send');
      expect(['quick', 'general']).toContain(r.task);
    }
  });

  it('degrades LOUDLY when there is no provider to offer', () => {
    const r = decideMobileRoute({
      message: 'Write a blog post about our new pricing strategy',
      selectedId: ON_DEVICE_PROVIDER_ID,
      providers: [],
      usableIds: withKeys(),
    });
    // It still answers — refusing would be worse — but it says why it is thin.
    expect(r.mode).toBe('send-degraded');
    expect(r.reason).toMatch(/Connect a model/);
  });

  it('never offers a provider whose key is missing', () => {
    // An offer we cannot authenticate is a broken promise, not a choice.
    const r = decideMobileRoute({
      message: 'Analyze the trade-offs between these two approaches',
      selectedId: ON_DEVICE_PROVIDER_ID,
      providers: [claude],
      usableIds: withKeys(), // no usable credential
    });
    expect(r.mode).toBe('send-degraded');
    expect(r.offer).toBeUndefined();
  });

  it('never offers the on-device model to itself', () => {
    const onDevice = { id: ON_DEVICE_PROVIDER_ID, label: 'On-device' } as ProviderMeta;
    const r = decideMobileRoute({
      message: 'Explain the difference between these two contracts',
      selectedId: ON_DEVICE_PROVIDER_ID,
      providers: [onDevice],
      usableIds: withKeys(ON_DEVICE_PROVIDER_ID),
    });
    expect(r.mode).toBe('send-degraded');
  });
});

describe('a chosen cloud provider is left alone', () => {
  it('sends everything there, including easy questions', () => {
    // Routing a question DOWN to the weak local model would be the mirror of
    // the desktop complaint: the user picked a model, they should get it.
    for (const message of ['what do I know about Bourne?', 'Why did this fail?']) {
      const r = decideMobileRoute({
        message,
        selectedId: 'p1',
        providers: [claude],
        usableIds: withKeys('p1'),
      });
      expect(r.mode, message).toBe('send');
      expect(r.reason).toBe('');
    }
  });

  it('treats an unselected state as on-device, the safe default', () => {
    const r = decideMobileRoute({
      message: 'Compare the pros and cons of these two plans',
      selectedId: null,
      providers: [ollama],
      usableIds: withKeys('p2'),
    });
    // Nothing selected must not mean "pick a cloud model for them".
    expect(r.mode).toBe('offer-cloud');
    expect(r.offer?.label).toBe('Mac Ollama');
  });
});

describe('task classification drives the split', () => {
  const cases: Array<[string, 'send' | 'offer-cloud']> = [
    ['what is my wifi password?', 'send'],
    ['function foo() { return 1 }  why does this throw?', 'offer-cloud'],
    ['write a poem about my dog', 'offer-cloud'],
    ['summarize everything I know about the Morgan St property', 'offer-cloud'],
    ['what do I know about my truck', 'send'],
  ];
  for (const [message, expected] of cases) {
    it(`routes "${message.slice(0, 40)}" to ${expected}`, () => {
      const r = decideMobileRoute({
        message,
        selectedId: ON_DEVICE_PROVIDER_ID,
        providers: [claude],
        usableIds: withKeys('p1'),
      });
      expect(r.mode).toBe(expected);
    });
  }
});
