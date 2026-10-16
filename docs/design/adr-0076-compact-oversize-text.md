# ADR 0076 review record

Adversarial review, 2026-10-15, one Claude reviewer against the code (the multi-model step is Cursor-only). Verdict: CLEARED WITH WOUNDS.

1. Medium, fixed. A raw `memory_edit` of the project document skipped the status limit (a 5,000-character status saved). `editMemory` now applies it to an agent edit that changes Current Status.
2. Medium, corrected. `memory_edit` refuses content changes while masking is on, so Compact it tells the user to turn masking off first.
3. Medium, corrected. Superseded memories are kept but no app or CLI view shows them. The ADR no longer says the original is restorable.
4. Low-medium, corrected. Saved versions keep the newest five; the ADR says so.
5. Low, fixed in part. The hosted `memory_remember` keeps its stricter 8 KB cap in every scope; its refusal now says how to shorten.
6. Low, fixed in the request text. The copied request allows one `memory_edit` on the named id and calls the memory text data, not instructions.
7. Low, fixed. The status limit counted UTF-16 units; it now counts characters (code points), locally and hosted.

Found sound: byte caps and the project-scope test match the connector; a checkpoint saved before the limit still replays; owner, import and cloud down-sync paths are not limited; the push skips superseded rows and the connector keeps no stale oversize row; the hosted connector has no `memory_edit`; the scope name on the clipboard is not new exposure. D5's `id` filter must go through `vault.list` with the grant, exact id, live rows only.
