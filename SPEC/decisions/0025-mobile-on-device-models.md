# ADR 0025: Mobile on-device models (private chat and Tier-2 redaction)

Status: Accepted (shipped in the iOS app), dated 2026-07-16; status corrected 2026-07-25 from a stale "Proposed" · Review: none recorded; on-device validation and adversarial review are listed as needed before merge. Open contradiction: the record says this ADR does not authorize shipping Tier-2-on-phone until the leak-corpus eval runs on a real device, yet its implementation notes say `runMobileTurn` upgrades a cloud turn to Tier-2 whenever a LocalModel is ready, and the eval had not been run.

## Context
Mobile needs an on-phone model for airplane-mode private chat and for Tier-2 redaction. Without an on-device model the phone can only offer Tier-1 as its floor, and invariant #6 requires saying so loudly.

## Decision
- D1: A `LocalModel` interface (`generateText`, `generateStructured`, `isReady`) that Converse and redaction depend on. Implementations: `AppleFMModel` (primary; `@react-native-ai/apple`, iOS 26+ on iPhone 15 Pro or later) and `LlamaRnModel` (llama.rn with a small GGUF; fallback and Android baseline).
- D2: When no model is available there is no Tier-2 and no private chat; a loud persistent banner shows, Tier-1 stays the floor, and cloud Converse stays available.
- D3: Tier-2-on-phone is gated by the seeded-secrets leak corpus, scored with the same function (`evaluateNer` in `packages/redact/src/eval.ts`) as the desktop Ollama baseline. Parity ships it as an active tier; Near ships it labelled "beta"; Poor means it is not used for redaction at all, only for private chat.
- D4: Private chat runs retrieval and generation through the `LocalModel` with no network call (endpoint classified `private`, tier 0).
- D5: On-device embeddings go in the existing cache table keyed by (memory_id, model): disposable, never exported, never hashed (invariant #4). No schema change.
- Current state (2026-07-17): `llama.rn` is de-linked after EAS build 4 failed; `LlamaRnModel` is an import-free stub, so `detectLocalModel` resolves to Apple-or-none. The real implementation is preserved at commit ca4e812. It landed on a parallel branch, not track-m, merge pending.

## Consequences
- Harder: older devices and Android have no on-device model until llama.rn is fixed.
- Limits, still open in the original: the eval has not been run on device; the adapters are written from docs and not yet run; the UI's three invariant-#6 states and the "stayed on device, nothing egressed" label are not built. New dependencies `@react-native-ai/apple` and `ai` are on-device at inference time.

## Rejected
- Cloud model for everything: loses airplane-mode private chat.
- Shipping Tier-2-on-phone unconditionally: an unmeasured redaction tier is a claim we cannot stand behind.

## What leaves the machine
The original has no egress section. It states private chat sends nothing ("memory in, answer out, on one device, offline"), and the cloud path "does send a redacted payload to the chosen provider", with Tier-1 the guaranteed floor. The GGUF download is a new networked dependency needing its own ADR and Jay's explicit OK (invariant #7) before `LlamaRnModel` ships; host and integrity check undecided.

## Links
Full record: docs/design/adr-0025-mobile-on-device-models.md · Related: ADR 0023
