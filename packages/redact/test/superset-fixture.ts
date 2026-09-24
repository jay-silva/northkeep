import type { OllamaClient } from '@northkeep/librarian';

/**
 * Shared inputs for the ADR 0060 W2 property (Tier 3 masks everything Tier 2
 * masks), used by the redact, chat, cloud review and MCP tests.
 */
export const SUPERSET_INPUTS = [
  'Meet Dana at First National Bank on Tuesday.',
  'Call Zorblax Quintavius at Acme Widgets, 774-555-0134.',
  'Dana Delgado moved from Portland to Barnstable County; she banks with First National Bank.',
  'Patient: Donna Hitchcock DOB: 03/15/1948. Seen at Cape Cod Hospital by Dr. Zyler Quandril.',
];
export const SUPERSET_ENTITIES = [
  'First National Bank', 'Acme Widgets', 'Zorblax Quintavius', 'Dana Delgado', 'Dana', 'Portland',
  'Barnstable County', 'Donna Hitchcock', 'Cape Cod Hospital', 'Zyler Quandril',
];

export function supersetNer(): OllamaClient {
  return {
    available: async () => true,
    generateJson: async (prompt: string) => {
      const text = prompt.slice(prompt.lastIndexOf('\nText:\n') + 7);
      const found = SUPERSET_ENTITIES.filter((e) => text.includes(e));
      return JSON.stringify({ entities: found.map((t) => ({ text: t, kind: /Bank|Widgets|Hospital/.test(t) ? 'org' : /Portland|County/.test(t) ? 'location' : 'person' })) });
    },
  } as unknown as OllamaClient;
}

/** Every word of every original Tier 2 masked must be absent from the Tier 3 text. */
export function missingAtTier3(tier2Originals: string[], tier3Text: string): string[] {
  const lower = tier3Text.toLowerCase();
  const missing: string[] = [];
  for (const original of tier2Originals) {
    for (const word of original.match(/\p{L}[\p{L}'\-]*|\d[\d\-\/]*/gu) ?? []) {
      if (word.length < 2) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u');
      if (re.test(lower)) missing.push(`${original} (${word})`);
    }
  }
  return missing;
}
