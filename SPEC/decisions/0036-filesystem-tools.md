# ADR 0036: Filesystem tools

Status: PARKED 2026-07-26 by Jay; not being built, kept as a decision record (drafted 2026-07-25) · Review: Revision 1 "do not implement as written" (2026-07-25); Revision 2 "PASTURE as written" (2026-07-26)

Superseded in part by ADR 0066 (accepted 2026-10-15): Converse is no longer presented as a product mode.

## Context
A filesystem tool (named in ADR 0027) is the first whose blast radius is the user's whole machine, and the vault is a file on it: a read tool is an exfiltration primitive aimed at local disk. Jay's bar: "if any chance exists that we are gonna leak the vault its a no go".

## Decision
- D1: Parked. Two revisions were defeated empirically in two days: Revision 1's floor by a differently-cased path (and a firmlink path), Revision 2's by a UTF-8 byte-order mark.
- D2: What decided it is Class B: `northkeep export | jq '.memories' > notes.json`, a CSV from it, a paragraph pasted into Word. After export these are ordinary user text with no marker; whether reading one leaks the vault is undecidable by construction. Strictly read, Jay's bar includes Class B, and "summarize this contract" does not pay for that KNOWN-LIMITS entry.
- D3: If revisited, start from the Revision 2 review's eight required changes, not Revision 2. Unverified idea: point the 16-gram `exfil.ts` overlap match inbound to catch verbatim Class B copies; paraphrase would escape.
- The drafted design, kept as the record: user-granted roots only; writes ask every time; delete/move/overwrite refused; results fenced. Revision 2 replaced Revision 1's name-based floor with four layers (content refusal, `dev`+`ino` deny-set, inode containment, open-then-check-then-read from the descriptor), dropped `always` grants for reads, turned distillation off for a turn that read a file, and added file content to the exfiltration screen corpus.

## Consequences
- Class A leaks (BOM, truncation, tar, base64, a device secret in any file not exactly 65 bytes) close by scanning for markers anywhere in the buffer instead of parsing or comparing whole; that fix refused every fixture. Class B does not close.
- Reviews found the live-object layers exact but other gaps: nothing binds a validated name to the held descriptor (worst case a file outside the root), undefined error paths, a missed sidecar (`${vaultPath}.pulled.tmp`), and TCC prompts from `~/Library`.
- Verified: no plaintext SQLite on disk; the audit log is content-free.

## Rejected
- Name-based path floor (Revision 1): APFS case-insensitivity, firmlinks and hardlinks defeat it.
- Point-check content refusal (Revision 2 L1): one-step container transforms defeat it.
- Per-root `always` read grants: no engine subject for directories, and prefix inheritance is refused by design.

## What leaves the machine
The original has no egress section, and the feature is parked, not built. The draft treated a read file as ordinary conversation content sent to the selected provider under invariant #1(a); the review (C2) found that wrong for an exported vault file, and found distillation would copy read content into the vault, where it syncs and can later be shared.

## Links
Parent: ADRs 0027, 0029, 0033 · Related: ADR 0037 · Full record: docs/design/adr-0036-filesystem-tools.md
