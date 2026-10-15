# Design record: notes and claims (ADR 0072)

## Storage
One SQLite file per vault, `notes-<32 hex>.db` in the NorthKeep home folder, named by a hash of the vault header's salt under its own label (packages/mcp-server/src/notes-store.ts). Opened with better-sqlite3, WAL and a 5 second busy timeout; created mode 0600. Tables: `meta` (the key-check row), `notes(seq, id, project, client_id, created_at, sender_key, blob)` with `UNIQUE (project, client_id)`, and `seen(reader_key, project, last_seq, updated_at)`. The blob is `nonce || XChaCha20-Poly1305(payload)`; payload `{ v: 1, kind, host, text, to, subject?, expires_at?, releases? }`. Project slug, ids, sender key (an MCP session id) and times stay readable.

Key: `deriveNotesKey` in packages/core/src/crypto.ts, keyed BLAKE2b of `nk-notes-key-v1` under the master key. The MCP server derives it in `withVault` before `Vault.openWithKey` takes the buffer, and wipes it after the call. Associated data: `v1|id|project|client_id|sender_key|created_at` (project-notes-crypto.ts). A key-check row detects a new vault or re-key. The MCP path, which has just opened the vault with the same key, resets the file on mismatch and the result carries `notes_reset_note`. The hook and owner CLI never reset; they print nothing or refuse. The hook also refuses a file with no key-check row and writes nothing while opening. Any future re-key must reset or re-encrypt this file. Each MCP project call that carries notes removes notes of projects no longer in the vault; the hook and CLI never prune.

## Claim rules (packages/core/src/project-notes.ts)
- Active: not expired, and no release row names it. Subjects compare tamed and lowercased.
- A claim on an actively claimed subject is refused, the holder included. Cap 10 active claims, 200 rows per project; pruning never drops an active claim.
- The check and insert run in one `BEGIN IMMEDIATE` transaction. Exclusive on one machine only.
- Release: the claiming MCP session, or the owner CLI (`northkeep notes --project <slug> --release <id>`). Any local program can run the CLI.
- A repeated `client_id` returns the stored note (`replayed: true`) only to the same session for the same request; otherwise `invalid_request`.

## Delivery
- project_get, project_resume, project_update, project_checkpoint, project_wrap and project_note results carry `notes` (unseen, addressed to this host or all, not your own, newest 5), `notes_count`, `active_claims` and `notes_notice`, only when there is something to show. A notes fault adds `notes_note` and never fails the call.
- Seen markers: per MCP session id, and `hook:<host>:<session>` for the hook. The two paths keep separate markers, so a Claude Code session can see one note twice. A new reader sees the last 24 hours.
- Shown note ids join the call's `result_ids`; text and subject are never logged.
- Text is one line (line breaks become spaces), control and hidden-direction characters and memory-fence markers removed, 280 characters; subject 80.

## Hook recipe (Claude Code)
In the repo's `.claude/settings.json`, Jay adds:
```json
{ "hooks": {
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "northkeep notes --project northkeep --hook" }] }],
  "PostToolUse": [{ "hooks": [{ "type": "command", "command": "northkeep notes --project northkeep --hook --min-interval 60" }] }]
} }
```
The command reads Claude Code's hook input on stdin (session id, event name), reads only the OS key store, never the vault, and prints `additionalContext` JSON or nothing. It prints nothing under any redaction tier, since notes are not masked. It never prompts and always exits 0. Besides its seen marker it appends one call-log row.

## Design reviews (2026-10-15, against main 7a060c8)
- Pass 1, NOT CLEARED, 11 findings: Review, consolidation and Converse would read notes stored in the vault; per-host read state hid notes between two sessions of one app; the share refusal lived in one function; claims across Macs and pull blocking; the ADR 0062 ledger does not cover notes; hook unlock; untamed subject and address; a false claim that only Jay could release; grants and the disclosure ledger; project delete; length.
- Pass 2, NOT CLEARED, 6 new: no per-entry sync merge exists; hook and MCP session ids differ; hiding notes from `list` breaks export; older builds would still read synced notes; renaming a scope breaks the hash chain; `scopes()` still listed them. Answered by moving notes out of the vault entirely.
- Pass 3, CLEARED WITH WOUNDS, 9: the key could be derived from a zeroed buffer; one file per vault; associated data; a hook resolver that reads only the key store; re-key; transaction and WAL; backups copy the file; notes are coordination, not memory; projects deleted elsewhere. All fixed in the text above.

## Code review (2026-10-15, executed against the branch)
CLEARED WITH WOUNDS. Key wipes, domain separation, nonces, file modes, the race, pruning, stale keys, grants and keepOnly found nothing. Fixed: the hook ignored the redaction tier; a reused client_id replayed another sender's note; host and `to` kept fence markers; the CLI skipped one key wipe; the hook could write a key-check row under an unproved key; the hook could exit non-zero; four doc errors. Kept as a limit: a note is marked seen before return masking, so a Tier 2 failure can drop it for that session. Full review: project file agent-messaging/adr-0072-code-review.md.

## Acceptance test
docs/agent-notes-acceptance.md.
