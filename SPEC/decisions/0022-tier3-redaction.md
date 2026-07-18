# ADR 0022 — Tier 3 redaction: deterministic names + date generalization

- **Date:** 2026-07-17
- **Status:** Accepted
- **Deciders:** Jay ("do it, we need to get this right" — after a Tier-2 turn sent a patient name and DOB to a cloud model), Claude Code

## Context

Tier 2's name pseudonymization rides a 3B local NER model, which missed a
patient name ("Donna Hitchcock") in a pasted EMS run report, and no tier
handled dates of birth at all. Jay's requirements: all names pseudonymized,
all DOBs generalized to year only. Jay chose a **new Tier 3** for the blanket
date rule, with Tier 2 gaining the narrower DOB-labeled rule, and asked for
the strongest possible name protection **without** a pre-send approval gate.

Honest framing that drove the design: a literal 100% guarantee on free-text
names requires a human gate, local-only routing, or structured templates. The
strongest no-gate posture is the approach of dedicated clinical de-identifiers
(UCSF Philter, MIT deid): **deterministic dictionary + structure rules first,
with models only ever adding masks on top**. That is what Tier 3 does.

## The tiers after this ADR (cumulative)

- **Tier 1** — deterministic secrets (email, SSN, card, phone, IP, IBAN, API
  key). Unchanged. Still the leak-test gate.
- **Tier 2** — Tier 1 + NER pseudonymization (unchanged) + **DOB-labeled dates
  → year only** (deterministic: a date within reach of "DOB", "date of birth",
  "born", "birthdate" labels becomes `[DATE-1948]`).
- **Tier 3 (new)** — Tier 2's NER **plus**, all deterministic:
  1. **Every full calendar date → year only** (`03/15/1948`, `March 15, 1948`,
     `1948-03-15`, `15 Mar 1948` → `[DATE-1948]`; dates with no year → `[DATE]`).
     Times of day and relative references ("3 days ago", "14:32") survive —
     they carry the QI value and are not Safe-Harbor identifiers by themselves.
  2. **Label-anchored names**: 1–3 capitalized tokens after `Patient:`,
     `Name:`, `Pt:`, `Mr./Mrs./Ms./Dr.` and similar → `Person-N`, dictionary
     hit or not (catches rare names the lists miss).
  3. **Name dictionaries**: any capitalized token on the bundled census
     surname list (162k) or SSA/NLTK first-name list (10.8k) → `Person-N`.
     This layer alone catches "Donna Hitchcock" with no model involved.
  4. **Capitalized-run rule**: a run of 2+ capitalized words where **at least
     one** token is on a name list → the whole run becomes one `Person-N`
     (so "Donna Hitchcock" is one person, and "Chief Complaint" / "Blood
     Pressure" headers — no name-list hit — are left alone for utility).
  5. **NER union + verify pass**: the Tier-2 NER runs before the dictionary
     layers and again after them; it can only ADD masks. If Ollama is
     unavailable, the deterministic layers still run but the tier is flagged
     degraded, and a degraded Tier-3 turn toward a bounded endpoint is
     REFUSED, exactly like Tier 2's rule (invariant #6, fail closed).

Pseudonyms restore in the reply (same `PseudonymMap` as Tier 2, so the same
name maps to the same `Person-N` across the conversation). Date masks are
one-way (`restorable: false`) — the model never needs the real date, and the
year is preserved in the placeholder for clinical relevance.

### Precision rules for the dictionary layer (deterministic, tested)

- Tokens inside existing placeholders (`[DATE-…]`, `Person-N`, `[EMAIL_1]`…)
  are never re-examined.
- **Sentence-initial veto, deliberately tiny**: a capitalized name-list token
  at sentence start is skipped ONLY if it is in the top-2000 English words by
  frequency AND the next word is lowercase (so "Will you…", "May I…" survive;
  "Donna is complaining…" does not — "donna" is outside the top-2000). The
  English list is rank-ordered for exactly this purpose.
- **Lowercase tokens**: masked only when on a name list AND absent from the
  full 20k English list (catches "cabral", not "young"). Lowercase common-word
  names ("donna" in lowercase) are left to the NER union — documented residual.
- Over-masking is accepted at Tier 3 by decision: "Mark the box" mid-sentence
  becomes `Person-N the box`. Privacy wins; the reply restores pseudonyms.

## What we may honestly claim

(Amended after the adversarial review of 2026-07-17, which falsified the
first draft's blanket "guaranteed" for all-caps names, possessives,
Mc/O'/hyphenated/accented surnames, ISO timestamps, and day-first dates —
all fixed and regression-tested; see `tier3.test.ts` "adversarial
regressions".)

- Dates: **deterministic for every recognized format** (numeric US and
  day-first, month-name incl. "15th of March", ISO with attached timestamps),
  leak-tested. Residual formats: spelled-out days ("March fifteenth"),
  compact digits ("19480315").
- Label-anchored and dictionary-listed names: **deterministic**, leak-tested —
  including ALL-CAPS narratives (with a caps-context exclusion list:
  "ALS"/"EMS"/"FOUND"/"STABLE" are census surnames, "DOB"/"YO"/"ER" are chart
  labels), possessives, punctuated caps names ("SMITH-JONES", "O'BRIEN"),
  Mc/Mac/O'/hyphenated/accented forms (normalized for lookup), the
  chart-classic "PATIENT: SMITH, JOHN", and — round 2 — the **FIRST→SUR pair
  signature**: "John Smith"/"DAVID BROWN" are names even though both words
  are rank-blocked individually, while "Vital Signs"/"Chief Complaint" never
  fire (their words are surname-list-only). Anchored common surnames ("MR
  SMITH") mask at any rank — the anchor is the evidence.
- Residual name risk: an off-list or lowercase name, un-anchored — including
  an off-list MULTI-word name ("Zyler Quandril") — missed by two independent
  NER passes; bare unanchored single word-surnames ("King said…", "FOUND BY
  SMITH"); and "de la Cruz"-style lowercase particles (only "Cruz" masks).
  Stated in KNOWN-LIMITS.md. We never claim "100% of names".

## Data files (new, bundled)

`packages/redact/data/{surnames.txt, firstnames.txt, english.txt}` (~1.5 MB):
2010 Census surnames (public domain), SSA-derived + NLTK first names (public
domain), google-20k English frequency list (rank order preserved). Loaded
lazily with `fs` at first Tier-3 use (mobile ships Tier-1 only and never loads
them). No network access; pure data. Refresh is manual and rare.

## Wiring

- `packages/redact`: `dates.ts`, `names.ts` (new), `Tier = 1|2|3`, kind
  `'date'` added; `redact()` orchestrates per tier.
- `turn.ts`: `redactTier` accepts 3; the degraded-toward-bounded refusal now
  covers tiers ≥ 2.
- GUI: tier picker gains "Tier 3 — max: names + dates"; the privacy-proof
  panel labels `date` masks; server accepts `tier: 3`.
- Leak-test: `packages/redact/test/tier3.test.ts` includes a seeded PCR-style
  corpus (invented patients) asserting zero name/DOB survivals from the
  deterministic layers — runs in CI with the suite.

## Rejected alternatives

- **Pre-send approval gate** — Jay explicitly wants no gate; may revisit.
- **Masking every capitalized word** — destroys clinical headers and utility.
- **English-list veto for capitalized tokens** — the web-corpus list contains
  "donna", "hitchcock", "mansfield"; a broad veto would recreate the exact
  miss this ADR exists to fix. Hence the tiny top-2000 + lowercase-next-word
  rule only.
