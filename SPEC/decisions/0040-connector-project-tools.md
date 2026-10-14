# ADR 0040: Connector project tools: Cloud can update a shared project.

Status: Accepted 2026-08-25 (M14) · Review: adversarial review, KEEP WITH PATCHES (both patches pinned in D3, D4) · Amended by ADR 0045 addendum (2026-09-19, D6), ADR 0050 (2026-09-19, D5 and D7) and ADR 0063 (2026-09-30)

## Context
ADR 0039 made a project one live `working` document in a `project:<slug>` scope, with local tools only. M14's outcome: Claude.ai can `project_update` a shared project, and after `northkeep share sync` the vault holds one live working document local agents can `project_get`.

## Decision
- D1: The hosted connector gains `project_list`, `project_get` and `project_update` (same merge code as desktop). No `memory_edit` on the connector; the 8 KiB `memory_remember` cap is unchanged.
- D2: A cloud update is a connector-born pending row (`origin='connector'`, `pending=true`), one per project scope, overwritten in place via the existing `(account, entry id)` upsert. No schema change.
- D3: No envelope rider. The pending row holds the full merged markdown as ciphertext under the per-account DEK, same envelope and custody as every row. `RowPlain` stays `{type, content}`; `/client/pending` is unchanged.
- D4: A project is only `project:` plus a slug matching `^[a-z0-9-]{1,40}$` (`parseProjectSlug` / `PROJECT_SLUG_PATTERN`), checked before any read, on the push cap and in the fold. A `project:` prefix alone is not a project.
- D5: Fail-closed: `project_update` needs a decryptable working base document; otherwise nothing is stored. Merges over 16384 characters are refused, never truncated. Current state: a connected app can create a project with hosted `project_create` (ADR 0050), and hosted `project_update` requires `expected_revision` (ADR 0063).
- D6: `PUT /client/entries` keeps the 8192-byte per-entry cap and 4 MB per push; 65536 bytes applies to every row in a valid project scope (ADR 0045 addendum; originally working rows only).
- D7: The desktop fold supersedes the local live document. Current state: the fold marks an empty scope Shared on arrival (ADR 0050), and down-sync (`applyDownSync`) applies a cloud document only as a fast-forward of the local head; anything else waits as a conflict (ADR 0063).

## Consequences
- Unshare deletes the scope's rows, including an undelivered update; the revoke wins.
- Residuals (accepted): a pre-M14 client folds an update as a new memory, keeping the prior document live and recoverable. Handlers are check-then-write, so an update racing an unshare can land after the delete, bounded by one request, as with `memory_remember`. Shared project documents are served in full by `memory_retrieve`, `memory_list` and ChatGPT's `search`/`fetch`, by consent.

## Rejected
- An encrypted-envelope rider: changes the envelope and `/client/pending`.
- Prefix-only project checks.
- Raising the ordinary memory cap.

## What leaves the machine
The original has no egress section. It states shared project content goes through the existing connector path, same envelope and custody; the server briefly holds the decrypted document while answering, as for every shared memory. At rest: encrypted, we store no key; the database alone yields no key and no plaintext.

## Links
Extends: ADR 0039 · Unchanged: ADR 0020 · Amended by: ADRs 0045, 0050, 0063 · Full record: docs/design/adr-0040-connector-project-tools.md
