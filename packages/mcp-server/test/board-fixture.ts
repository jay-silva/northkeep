/**
 * The saturating board fixture (ADR 0054 Decision 3): 110 projects, so every
 * section is over its 50-row cap at once, with every text field at its cap in
 * the widest form it can take on the wire. `"` and `\` cost 4 bytes per unit
 * once the payload is JSON-encoded twice, CJK costs 3, and email-shaped text
 * grows under Tier-1 masking. 'widest' is the byte maximum; 'mixed' has all three. Shared by the MCP and CLI tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { callLogPath, type Vault } from '@northkeep/core';

export const BOARD_WIRE_CEILING = 131072;
export const SATURATING_HEALTHY = 55;
export const SATURATING_BROKEN = 55;

const QB = '"\\';
const HAN = '漢';
const WRITER = { host: 'board-fixture', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

/** A 40-character slug, the widest PROJECT_SLUG_PATTERN allows. */
export function wideSlug(kind: string, i: number): string {
  const head = `${kind}-${String(i).padStart(3, '0')}-`;
  return head + 'a'.repeat(40 - head.length);
}

export type BoardFixtureVariant = 'widest' | 'mixed';

function fill(i: number, units: number, prefix = '', variant: BoardFixtureVariant = 'widest'): string {
  // 'widest' is all 4-byte units. 'mixed': every seventh row is CJK, every eleventh grows under Tier-1.
  if (variant === 'widest') return prefix + QB.repeat(units);
  if (i % 11 === 5) return prefix + 'someone@example.com '.repeat(Math.ceil(units / 20));
  if (i % 7 === 3) return prefix + HAN.repeat(units);
  return prefix + QB.repeat(units);
}

function uuid(i: number, k: number): string {
  const hex = (i * 16 + k).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-1111-4111-8111-${hex}`;
}

/** Writes the projects into an open vault (caller saves) and the open-session rows into the call log. */
export function seedSaturatingBoard(v: Vault, variant: BoardFixtureVariant = 'widest', now: Date = new Date()): { healthy: string[]; broken: string[] } {
  const healthy: string[] = [];
  const broken: string[] = [];
  for (let i = 0; i < SATURATING_HEALTHY; i += 1) {
    const slug = wideSlug('h', i);
    healthy.push(slug);
    const nextActions = [1, 2, 3].map((d) => fill(i + d, 160, `- 2026-10-${String(d + (i % 20)).padStart(2, '0')} `, variant)).join('\n');
    v.updateProject({
      project: slug, expected_revision: null, what_why: 'Why this project exists.',
      status: fill(i, 130, '', variant), next_actions: nextActions, draft: true, writer: WRITER,
    });
  }
  for (let i = 0; i < SATURATING_BROKEN; i += 1) {
    const slug = wideSlug('b', i);
    broken.push(slug);
    const scope = `project:${slug}`;
    if (i % 2 === 0) {
      v.remember({ content: '## Current Status\n\nOne.', type: 'working', scope });
      v.remember({ content: '## Current Status\n\nTwo.', type: 'working', scope });
    } else {
      v.remember({ content: '## Current Status\n\nOne.\n\n## Current Status\n\nTwo.', type: 'working', scope });
    }
  }
  const lines: string[] = [];
  healthy.forEach((slug, i) => {
    for (let k = 0; k < 4; k += 1) {
      const ts = new Date(now.getTime() - (i * 4 + k + 1) * 60_000).toISOString();
      lines.push(JSON.stringify({ ts, tool: 'project_get', host: fill(i + k, 80, '', variant), session_id: uuid(i, k), params: { scope: `project:${slug}` }, ok: true }));
    }
  });
  fs.mkdirSync(path.dirname(callLogPath()), { recursive: true });
  fs.appendFileSync(callLogPath(), `${lines.join('\n')}\n`, { mode: 0o600 });
  return { healthy, broken };
}
