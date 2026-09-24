/**
 * Reading the name model's reply (ADR 0060 code review, kill shot). JSON.parse
 * keeps only the LAST of two "entities" keys, and a real llama3.2:3b returned
 * {"entities":[Bob Henderson],"entities":[...]} in 8 of 10 runs, so the found
 * name was thrown away and the text went out unmasked while reporting Tier 2.
 *
 * Shared by the desktop name layer (redact's applyTier2) and the phone's
 * per-kind pass (platform-mobile), ADR 0060 O3. This parser keeps every
 * duplicate key. A reply is accepted only when it can
 * be fully accounted for: one object whose keys are all "entities", each an
 * array of objects whose "text" values are strings. Anything else throws, and
 * the caller treats the text as degraded (refuse at Tier 2), never as clean.
 */

type Json = string | number | boolean | null | Json[] | { pairs: Array<[string, Json]> };

class Reader {
  private i = 0;
  constructor(private readonly s: string) {}

  fail(): never {
    throw new Error('Tier-2 model reply could not be read in full.');
  }

  ws(): void {
    while (this.i < this.s.length && ' \t\n\r'.includes(this.s[this.i]!)) this.i += 1;
  }

  done(): boolean {
    this.ws();
    return this.i >= this.s.length;
  }

  value(depth = 0): Json {
    if (depth > 32) this.fail();
    this.ws();
    const c = this.s[this.i];
    if (c === '{') return this.object(depth);
    if (c === '[') return this.array(depth);
    if (c === '"') return this.string();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(this.s.slice(this.i));
    if (!m) this.fail();
    this.i += m[0].length;
    return JSON.parse(m[0]) as Json;
  }

  string(): string {
    const m = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(this.s.slice(this.i));
    if (!m) this.fail();
    this.i += m[0].length;
    return JSON.parse(m[0]) as string;
  }

  array(depth: number): Json[] {
    this.i += 1;
    const out: Json[] = [];
    this.ws();
    if (this.s[this.i] === ']') { this.i += 1; return out; }
    for (;;) {
      out.push(this.value(depth + 1));
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') return out;
      if (c !== ',') this.fail();
    }
  }

  object(depth: number): { pairs: Array<[string, Json]> } {
    this.i += 1;
    const pairs: Array<[string, Json]> = [];
    this.ws();
    if (this.s[this.i] === '}') { this.i += 1; return { pairs }; }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail();
      const key = this.string();
      this.ws();
      if (this.s[this.i++] !== ':') this.fail();
      pairs.push([key, this.value(depth + 1)]);
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') return { pairs };
      if (c !== ',') this.fail();
    }
  }
}

function isObject(v: Json): v is { pairs: Array<[string, Json]> } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export interface NerReplyEntity {
  text: string;
  kind: unknown;
}

/** Every entity in every "entities" array of the reply, or a throw. */
export function readNerReply(raw: string): NerReplyEntity[] {
  const reader = new Reader(raw);
  const top = reader.value();
  if (!reader.done() || !isObject(top)) return reader.fail();
  const out: NerReplyEntity[] = [];
  let sawEntities = false;
  for (const [key, list] of top.pairs) {
    if (key !== 'entities' || !Array.isArray(list)) return reader.fail();
    sawEntities = true;
    for (const item of list) {
      if (!isObject(item)) return reader.fail();
      const texts = item.pairs.filter(([k]) => k === 'text').map(([, v]) => v);
      const kinds = item.pairs.filter(([k]) => k === 'kind').map(([, v]) => v);
      if (texts.length === 0 || texts.some((t) => typeof t !== 'string')) reader.fail();
      // A repeated "text" key is two spans, never one silently dropped.
      for (const t of texts) out.push({ text: t as string, kind: kinds[0] ?? null });
    }
  }
  if (!sawEntities) reader.fail();
  return out;
}
