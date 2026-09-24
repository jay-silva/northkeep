import { describe, expect, it, vi } from 'vitest';

// The package index also loads the Apple FM bridge, a native module Node
// cannot load; the client only needs the pure prompt helper.
vi.mock('@northkeep/platform-mobile/dist/local-model/index.js', async () => {
  const { extractNerText } = await import('@northkeep/platform-mobile/dist/local-model/per-kind-ner.js');
  return { extractNerText };
});

const { createNLTaggerNerClient } = await import('../src/lib/nltagger-ner');

/**
 * ADR 0060 O3: the phone's name net fails closed. A prompt this client does
 * not recognise used to return "no entities", a clean pass with every name
 * unmasked; it now throws, so the turn is degraded and the phone says so.
 * Only the no-native path is exercised here (Node has no NLTagger).
 */
describe('NLTagger client fails closed', () => {
  it('an unrecognised prompt shape throws instead of reporting no names', async () => {
    await expect(createNLTaggerNerClient().generateJson('Bob Henderson called about the lease.')).rejects.toThrow(
      'unexpected name-model prompt',
    );
  });

  it('an empty text still returns no entities', async () => {
    await expect(createNLTaggerNerClient().generateJson('Extract named entities.\nText:\n   ')).resolves.toBe('{"entities":[]}');
  });
});
