# ADR 0022: Tier 3 redaction: deterministic names + date generalization

Status: Accepted 2026-07-17 · Review: 2026-07-17 adversarial review falsified the draft's blanket "guaranteed"; fixed, regression-tested, claims below amended. Tier 1 corrected 2026-09-24 (0.22.0 doc-vs-code pass; see ADR 0059).

## Context
Tier 2's 3B local NER model missed a patient name ("Donna Hitchcock") in an EMS run report, and no tier handled dates of birth. Jay asked for all names pseudonymized and DOBs cut to year, as strongly as possible without a pre-send gate. A literal 100% guarantee on free-text names needs a gate, local-only routing or templates; the strongest no-gate posture is deterministic dictionary and structure rules first, models only adding masks.

## Decision
- D1: Tier 2 gains a deterministic rule: a date near "DOB", "date of birth", "born" or "birthdate" becomes `[DATE-1948]` (year only).
- D2: New Tier 3 = Tier 2's NER plus deterministic layers: every full calendar date to year only (`[DATE-1948]`, or `[DATE]` without a year; times and relative references survive); label-anchored names (1 to 3 capitalized tokens after `Patient:`, `Name:`, `Pt:`, `Mr./Mrs./Ms./Dr.`) to `Person-N`; name dictionaries (162k census surnames, 10.8k first names); a capitalized run of 2+ words with one name-list hit becomes one `Person-N`.
- D3: NER runs before and after the dictionary layers and can only add masks. Without Ollama the deterministic layers still run, the tier is flagged degraded, and a degraded Tier-3 turn toward a bounded endpoint is refused (invariant #6, fail closed).
- D4: Pseudonyms restore in the reply via the shared `PseudonymMap`; date masks are one-way (`restorable: false`).
- D5: Precision rules are narrow (sentence-initial veto only for top-2000 English words before a lowercase word); over-masking ("Mark the box") is accepted.
- D6: Bundled data `packages/redact/data/{surnames.txt, firstnames.txt, english.txt}` (~1.5 MB), loaded lazily at first Tier-3 use; mobile ships Tier-1 only.

## Consequences
- Claimable: dates are deterministic for every recognized format, leak-tested; label-anchored and dictionary-listed names are deterministic, leak-tested (incl. ALL-CAPS, possessives, Mc/O'/hyphenated/accented forms, FIRST-SUR pairs).
- Residual risk, in KNOWN-LIMITS.md: spelled-out or compact dates ("March fifteenth", "19480315"); off-list or lowercase unanchored names, including multi-word ones, missed by both NER passes; bare unanchored single surnames ("King said..."); "de la Cruz" particles. We never claim "100% of names".
- Tier 1 today (ADR 0059) masks prefixed keys and tokens (36 issuer prefixes, private-key blocks, Google API keys, JWTs), Luhn-valid cards, SSNs, IBANs, emails, phones, IPs, GPS coordinates, street addresses, adjacent ZIPs and labeled record/account numbers; it does not catch an unprefixed key, a password, or a secret in ordinary words.

## Rejected
- Pre-send approval gate: Jay wants no gate; may revisit.
- Broad English-list veto: the list contains "donna" and "hitchcock", recreating the miss.

## What leaves the machine
The original has no egress section. It states the data files need no network access; Tier 3 only adds masks before text reaches the user's chosen model, with the residual risks above.

## Links
Full record: docs/design/adr-0022-tier3-redaction.md · Amended by: ADR 0059 (Tier 1)
