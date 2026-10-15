# Open risks

Open questions where a record contradicts itself, contradicts the code, or may make a false claim. Each needs Jay's decision or a review; none is fixed by editing this file. Re-verified against the ADRs and code on 2026-10-15. Source: the ADR length pass (2026-09).

## Needs Jay's decision first

- **ADR 0026, App Store privacy label: likely false public claim.** D5 says the label is "Data Not Collected", and the record quotes "BYOK keys and the vault never leave the device except the vault ciphertext to the user's own sync account". Cloud Converse on the phone sends redacted text to the provider the user picked (ADR 0025), and Cloud Connect stores shared scopes and a request log. `docs/appstore-privacy-label.md` already says the blanket "Data Not Collected" cannot be used. Check the live App Store Connect label, then correct ADR 0026 or the label.

## Status says shipped, but required checks are not recorded

- **ADRs 0023, 0024, 0025** (mobile crypto, device linking, on-device models): "Accepted (shipped in the iOS app)", yet each body says it stays Proposed until a review or evaluation runs (the invariant #3 key review, the on-device spike, the leak-corpus eval on a device). No record logs the result. Record the results or downgrade the status.
- **ADR 0020** (connector encryption at rest): the header says review completed; the closing line says a code-level review gates the merge. No code-level verdict is recorded.
- **ADR 0019** (hosted connector): a full-surface review was required before the C5 beta. No record shows it ran.

## Records that disagree with the code or themselves

- **ADR 0049:** forbids starting a service automatically, but D7's search warmer can start Ollama. The record marks this open.
- **ADR 0053:** mirror files are written mode 0644 (`writeMirrorFile`, `packages/mcp-server/src/fs-safe.ts`). The ADR 0061 design record (finding C6) left it for a separate fix that has not landed.
- **ADR 0025:** the phone code has moved past the record (per-kind NER adapters in `packages/platform-mobile/src/local-model/`), which the record does not describe.

## Re-checked and still accurate

- **ADR 0039:** "two machines editing before sync still lose one side" holds for whole-vault sync. ADR 0063 guards cloud project writes, not vault sync.

## Already fixed (dropped)

- ADR 0042: now states the 4096-byte limit (originally 2048).
- ADR 0050: D4 now says every row in the group is applied, including the semantic row a review found.
- ADR 0059: D2 now names the AWS exact-length exception.
- ADR 0061: no decisions listed as pending.
- ADR 0018: notes that its ADR 0019 citation landed as 0024.
- ADR 0011: names `packages/converse/src/catalog.ts`.
- ADR 0017: says later ADRs added outbound hosts.

When an item is resolved, delete it here in the same pull request.
