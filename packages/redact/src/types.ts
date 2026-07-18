export type Tier = 1 | 2 | 3;

export type SecretKind =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit_card'
  | 'ip'
  | 'api_key'
  | 'iban'
  | 'record_id'
  | 'gps'
  | 'zip';

export type EntityKind = 'person' | 'org' | 'location';

/** Generalized calendar dates (ADR 0022): `[DATE-1948]` / `[DATE]`. */
export type DateKind = 'date';

/** One redaction: the placeholder that replaced a span, and what it hides. */
export interface Replacement {
  /** e.g. `[SSN]`, `[EMAIL_1]`, `Person-1`, `Org-2`, `[DATE-1948]` */
  placeholder: string;
  /** The original text that was masked. */
  original: string;
  tier: Tier;
  kind: SecretKind | EntityKind | DateKind;
  /** Whether restore() puts `original` back. Tier-1 secrets are one-way
   * (the model never needs your real SSN); Tier-2 pseudonyms round-trip. */
  restorable: boolean;
}

export interface RedactionResult {
  redacted: string;
  replacements: Replacement[];
  tierApplied: Tier;
  /** True when Tier-2 was requested but unavailable (no Ollama) — the caller
   * MUST surface this (invariant #6: degrade privacy loudly). */
  tier2Degraded: boolean;
}

export interface RedactOptions {
  /** 1 = deterministic secrets only; 2 = + NER pseudonyms and DOB-labeled
   * dates; 3 = + ALL dates to year, dictionary/anchor name scrubbing, and an
   * NER verify pass (ADR 0022). */
  tier?: Tier;
  /** Reuse/extend a pseudonym map so the same entity gets the same
   * placeholder across calls (consistent pseudonyms). */
  pseudonyms?: PseudonymMap;
  /** 'replay-only' skips the NER model and only replays KNOWN pseudonyms from
   * the map (plus all deterministic layers). Used for conversation HISTORY,
   * whose entities were already detected in their original turn — re-running
   * the 3B model over every history message every turn made long chats hang
   * (field report 2026-07-18). Default 'on'. */
  nerMode?: 'on' | 'replay-only';
}

/** entity text (lowercased) → stable placeholder, e.g. "bob henderson" → "Person-1". */
export type PseudonymMap = Record<string, string>;
