# ADR 0029: The harness security model: permission engine and exfiltration screens

Status: Accepted 2026-07-24 · Review: no overall verdict recorded; findings from the M10b review (G2) and rounds G1/G3 are folded into D2

Superseded in part by ADR 0066 (accepted 2026-10-15): Converse is no longer presented as a product mode.

## Context
M10b asked on every call; permission fatigue is a security failure. Review G2 showed the Tier-1 egress floor matches literal strings, so encoded secrets slip past. M10c adds a narrow-grant engine and screens over decoded arguments.

## Decision
- D1: Screens run in `runTask` on restored plaintext arguments, before the gate, never inside the injectable `PermissionGate`. The gate sees only (tool, host, risk, screened).
- D2: `screenArguments` (exfil.ts) splits the URL into host, path, query and fragment plus every JSON string leaf; unparseable input is screened whole. Each part is unwrapped by up to six rounds of percent and base64/base64url decoding. Classes: `secret` (Tier-1 shapes), `identity` (pseudonym real-values of 4+ normalized chars), `memory` (16-gram overlap, or whole substring for 8 to 16 chars, with any vault memory disclosed in this conversation; under 8 chars is not screened, `MIN_SHORT_MEMORY`). The host is screened for secrets only.
- D3: SSN, card, IBAN or API key: hard deny before the gate, visible and audited. Every other flag forces an ask with plain-sentence warnings; grants are ignored. Flags never contain matched text.
- D4: Consent: yes once, this session, always (`~/.northkeep/permissions.json`), no, never. Order: `never` deny; `consequential` ask; `screened` ask; grant auto-allow; else ask. Grants are exact host, case-insensitive, per tool, no wildcards or subdomains. Scoped allows persist only for safe-read, unflagged calls; `never` always persists. File 0600 (re-applied each write); malformed entries ignored. Grants are made only at a live prompt; `northkeep tools grants`/`revoke` list and remove them. Only `persist: true` surfaces (the CLI) touch the file. A multi-conversation surface must create one engine per conversation.
- D5: Audit rows record the scope remembered (or `auto`) and descriptors like `secret:ssn:query:decoded`, never values.

## Consequences
- Limits: screens are syntactic; semantic paraphrase passes. Encodings past six rounds or not decoded (ROT13, gzip), values split across components or dribbled per call, and identity/memory placed in the host all pass. Oversized arguments are screened by prefix; a throwing screen hard-denies.
- Strongest practical attack: an `always` grant removes the prompt that backstops every limit above, so a hostile page plus one grant can dribble vault content to that host unprompted, visible only in the transcript and audit. No per-turn auto-allow cap or unusual-volume re-prompt is built yet.
- A granted host serving different content is invisible to the engine.

## Rejected
- Screens in the gate: a permissive surface would lose them.
- A fixed decode pipeline or a turn-scoped memory screen: both leaked in review (G1/G3).
- Wildcard grants: a quiet blanket permission.

## What leaves the machine
The original has no egress section. It governs when tool-call arguments may leave: after these screens, then a live approval or a matching grant (which skips the prompt for screen-clean calls).

## Links
Parent: ADR 0027 · Companion: ADR 0028 · Full record: docs/design/adr-0029-harness-security-model.md
