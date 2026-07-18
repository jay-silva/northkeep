export type Tier = 1 | 2 | 3;

export type SecretKind =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit_card'
  | 'ip'
  | 'api_key'
  | 'iban';

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
}

/** entity text (lowercased) → stable placeholder, e.g. "bob henderson" → "Person-1". */
export type PseudonymMap = Record<string, string>;
