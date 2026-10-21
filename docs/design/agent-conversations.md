# Design record: conversations between local AI apps (ADR 0079)

Extends the notes file and rules of ADR 0072 (docs/design/agent-notes-and-claims.md). Everything here stays on one Mac. Old and new builds share the file: an MCP server keeps the code it started with (CLAUDE.md), so every change below is checked against a 0072 server reading the same rows.

## Data

Payload stays version 1 (packages/core/src/project-notes.ts) with two optional fields:

```ts
interface NotePayload {
  v: 1;
  kind: 'note' | 'claim' | 'release';
  host: string;        // canonical app name, tamed
  text: string;        // one line, up to 1,000 characters
  to: string;          // canonical app name or 'all'
  subject?: string;    // claims only
  expires_at?: string; // claims only
  releases?: string;   // releases only
  reply_to?: string;   // notes only: the note answered
  thread?: string;     // notes only: the root note's id
}
```

Why not `v: 2`: `openNote` in packages/core/src/project-notes-crypto.ts accepts a row only when `v === 1`. Review 1 executed it: a v2 row is dropped by a 0072 server without a word, and a v2 claim lets a 0072 server grant a second claim on the same subject. A v1 row with extra fields opens unchanged, so a 0072 server shows a reply as a plain note and still refuses a duplicate claim.

Rows, blobs, associated data and the key-check row are unchanged. A reply must name an existing note of the same project; `thread` is copied from the parent, or is the parent's id when the parent is a root. A reply to a claim or release is allowed; a claim or release is never itself a reply. A reply addresses the parent's sender by default (`to` may still be set).

### Shown table (replaces the high-water marker for 0079 readers)

```sql
CREATE TABLE IF NOT EXISTS shown (
  note_id TEXT NOT NULL,
  reader_key TEXT NOT NULL,
  host TEXT NOT NULL,
  shown_at TEXT NOT NULL,
  PRIMARY KEY (note_id, reader_key)
);
```

A row is written only when a note is actually included in a tool result, a wait result or a hook's output, in the same transaction as the read. Rules:

- Unseen for a reader: addressed to its host or `all`, not its own, no `shown` row for (note, reader), and written within the last 24 hours. A note is deliverable for one day; after that it is history, visible in the panel and the owner view only. Active claims always show. The window applies to every reader, every time (the recheck showed that a window for new readers only let a session page through a 200-note backlog five at a time).
- Results still show the newest `NOTES_SHOWN` (5) unseen notes and count the rest; the rest stay unseen and come up on the next read instead of being lost. This is the behaviour change from 0072 D3, and review 1 is why: the 0072 marker is set to the project's highest sequence on every read, so it also "saw" notes that were cut off, addressed to someone else, or the reader's own.
- Receipts (`seen_by`): the distinct `host` values of `shown` rows for that note, excluding the sender's host, so two sessions of one app never show each other a receipt (a missing receipt, never a false one). A 0072 server never writes `shown`, so a note read only by an old build shows no receipt until that app restarts on the new build. KNOWN-LIMITS records this, and that the first 0079 hook call in a session that the 0072 hook served re-shows up to a day of notes once.
- The 0072 `seen` table and `markSeen` stay for 0072 readers; a 0079 reader neither reads nor writes them. Reader keys are per session (one server per session), so the two never mix.
- Pruning: `notesToPrune` is unchanged (200 rows per project, never an active claim). `shown` rows are deleted with their notes and after 30 days, in the same places `seen` is trimmed today. A 0072 build's prune, `keepOnly` or reset leaves `shown` rows behind; they match nothing and the 30-day trim removes them. A reply whose root was pruned is shown with `thread` pointing at a missing id; the panel renders it as its own card with "replying to an earlier message".

### Canonical app names

One table in packages/core/src/project-notes.ts. The reported names come from Jay's call log on 2026-10-21 (853 rows `local-agent-mode-northkeep`, 2,463 `codex-mcp-client`, 38 `claude-code`, 8 `cursor-vscode`, 2 `claude-ai`); they are what the MCP handshake's `clientInfo.name` carried.

| reported by the app | canonical |
|---|---|
| `local-agent-mode-northkeep` | `claude-desktop` |
| `claude-ai` | `claude-desktop` |
| `claude-code` | `claude-code` |
| `cursor-vscode`, `cursor` | `cursor` |
| `codex-mcp-client`, any name starting with `codex` | `codex` |
| `northkeep-app`, `northkeep-cli` | `northkeep` |

Unknown names pass through `tameHost` unchanged. The table is applied when a note is stored, when `to` is parsed, and when a reader's host is compared, so old rows with raw names still match. Mixed builds: a 0072 server started before the upgrade compares its raw host (`cursor-vscode`) to a stored `to` of `cursor` and misses it; notes to `all` still arrive. Restarting the app fixes it. KNOWN-LIMITS records this.

## Tools

`project_note` gains `reply_to` (a note id). Its result adds `thread` and `seen_by`. A release never counts against the notes cap, so a capped session can always release its own claim.

`project_wait` (new):

```
project_wait({ project, seconds?: 1..25 (default 20), thread?: noteId })
→ { notes, notes_count, active_claims, notes_notice, waited_ms }
   or { timed_out: true, waited_ms }
```

Steps:
1. Inside the ordinary `run` envelope (pending log row, tier check, grant), a short vault call checks the grant and that the project exists, derives the notes key, and returns. The vault and its file lock are released here.
2. The server reads once: unseen notes already pending (inside `thread` when given) return at once with `waited_ms: 0`. Otherwise it polls `SELECT MAX(seq) FROM notes WHERE project = ?` every 500 ms, decrypting only when the sequence moves. Reads never block under another process's `BEGIN IMMEDIATE` (review 1 measured 0 to 1 ms per poll during a 7 s hold).
3. On an unseen note for this reader it builds the 0072 notes block, writes `shown` rows for exactly the notes it returns, logs their ids and returns. With `thread` set, notes outside the thread stay unseen; nothing is skipped.
4. After `seconds` it returns `timed_out`.
5. The key is wiped on every exit path. If the `shown` insert hits `SQLITE_BUSY` (5 s busy timeout), the wait returns the notes anyway and logs `notes_note`; the notes come up again next time, which is the safe side.

Redaction: `mask: 'project'`, like a project read, so under tier 1 or 2 the returned text is masked the same way and the hook stays silent. Nothing new is written under a tier (a `shown` row is bookkeeping, not content).

Why outside the lock: `withFileLock` (packages/core/src/lock.ts) is advisory, waits 5 s, and is stolen after 60 s for a live owner or at once for a dead one. A wait inside it would turn one agent's patience into every other agent's failure.

Caps per MCP session, counted in the server process: 30 waits per hour (`wait_budget_exhausted`), 60 notes per hour (`too_many_notes`). Both are refusals that name when the budget resets. They reset when a host respawns its server; they exist so two agents cannot loop at the user's token cost, not as security.

## Hooks (three hosts, one command)

`northkeep notes --project <slug> --hook --host <claude-code|codex|cursor> [--min-interval 60]`

| host | stdin id field | id gate | events the hook accepts | output |
|---|---|---|---|---|
| claude-code | `session_id` | UUID (unchanged) | `UserPromptSubmit`, `PostToolUse` | `{"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}}` |
| codex | `session_id` | 4 to 128 of `[A-Za-z0-9_.:-]` | `SessionStart`, `UserPromptSubmit`, `PostToolUse` | same as claude-code |
| cursor | `conversation_id` | 4 to 128 of `[A-Za-z0-9_.:-]` | `sessionStart`, `postToolUse`, `postToolUseFailure` | `{"additional_context": …}` |

Neither vendor documents its id format (examples: `thr_123`, `conv-456`), so the gate for them is a bounded character class, not the UUID regex 0072 uses for Claude Code; the id reaches disk only through a hash and SQLite only as a value. Reader key stays `hook:<host>:<id>`. Everything else in 0072 D5 holds: key store only, never the vault, nothing under a redaction tier, exit 0 always, one call-log row. The hook writes `shown` rows like a tool result, except on Cursor's `sessionStart`.

Cursor's `sessionStart` is fire-and-forget in Cursor's docs, so whether its `additional_context` lands is unconfirmed; `postToolUse` (which fires for MCP tools too) is the delivery path, `sessionStart` is a bonus that writes no `shown` rows, so a note it printed into the void is still delivered later. Cursor's `beforeSubmitPrompt` has no context output (cursor.com/docs/agent/hooks, read 2026-10-21). Codex hooks are on by default and must be trusted once through `/hooks` (learn.chatgpt.com/docs/hooks, read 2026-10-21); Jay's Mac runs codex-cli 0.159.1.

Recipes Jay installs himself (user-level files, so they cover every repo):

Claude Code, `~/.claude/settings.json` or the repo's `.claude/settings.json`: as in docs/design/agent-notes-and-claims.md.

Codex, `~/.codex/hooks.json`:
```json
{ "hooks": {
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "northkeep notes --project northkeep --hook --host codex" }] }],
  "PostToolUse": [{ "hooks": [{ "type": "command", "command": "northkeep notes --project northkeep --hook --host codex --min-interval 60" }] }]
} }
```

Cursor, `~/.cursor/hooks.json`:
```json
{ "version": 1, "hooks": {
  "sessionStart": [{ "command": "northkeep notes --project northkeep --hook --host cursor" }],
  "postToolUse": [{ "command": "northkeep notes --project northkeep --hook --host cursor --min-interval 60" }]
} }
```

## Conversation panel (Mac app)

`GET /api/projects/<slug>/notes` on the local web server (apps/web/src/projectsApi.ts) returns threads newest first: each root note with its replies in order, canonical names, `seen_by`, and active claims. The server opens the file through a new `NotesFile.openReadOnly(path, key)`: SQLite opened read only (`readonly: true, fileMustExist: true`), no table creation, no key-check write, no retention delete, no reset; SQLite may still create its `-wal` and `-shm` sidecar files. A missing file or a key-check mismatch returns `{ unreadable: true }` and the page says the notes file cannot be read. (`NotesFile.open` is not read only: it takes `BEGIN IMMEDIATE`, trims `seen`, and creates the file and key-check row; review 1.) The panel writes no `shown` rows: Jay reading is not an app seeing. The project page shows a Conversation section under the milestones: one card per thread, replies indented, claims as a short list above. No input, no actions. The mock (agent-messaging/conversation-panel-mock.html, built 2026-10-21) goes to Jay first; the panel is built only after he approves it.

## Threat notes

- A reply is text from another local program, like a note. The notice is on every result and hook output; `project_wait` results carry it too.
- Any local program can still post as any app (0072 limit). Canonical names do not change that; they only make the names readable.
- A wait reads the file and writes only `shown` rows for what it returned; it cannot hold the vault and ends by itself.
- The panel is loopback only, session-token gated (apps/web/src/server.ts), and read only; the browser cannot post.

## Tests

- core: thread building, reply validation, canonical names, unseen and receipts from `shown` rows (a note cut off by NOTES_SHOWN stays unseen; a note to another app is not "seen"; the sender's host is never in `seen_by`; a note 25 hours old is not delivered, one 23 hours old is).
- mcp-server: reply round trip between two sessions; wait returns on a reply and times out otherwise; a thread wait leaves an unrelated note unseen; wait while another session holds the vault lock (must still return); caps; release under a notes cap.
- compatibility: a 0072-shaped reader (the 0072 `notesForReader` over the same rows) still reads a reply row and still refuses a duplicate claim.
- e2e (real processes): Cursor asks, Claude Code replies, Cursor's wait returns the reply; `seen_by` lists claude-code after Claude's read and never cursor; the hook prints Cursor's shape and Codex's shape from recorded stdin with their id formats.
- web: the notes route returns threads, refuses a locked session, and reports `unreadable` on a mismatched file without changing it.

## Acceptance (Jay, after merge)

1. Cursor: "Use NorthKeep project_note to tell claude-desktop: are you in vault.ts? Then project_wait for a reply."
2. Claude desktop: "Run project_resume for northkeep and reply to Cursor's note with project_note reply_to."
3. Cursor's wait returns the reply inside the same turn when step 2 runs within the wait; otherwise Cursor's next wait or read shows it.
4. The Mac app's project page shows the thread with both names.
5. Hooks: with the Codex and Cursor recipes installed, a note from Claude desktop shows in each after its next tool call.

## Reviews

### Review 1 (2026-10-21, fresh eyes, executed against main 7a38dc8 in the worktree)

NOT CLEARED. Scripts and outputs: project files agent-messaging/adr-0079-review-1.md.

- KILL SHOT: payload `v: 2` is dropped by 0072's `openNote` and a v2 claim lets a 0072 server grant a duplicate claim. Fixed: the payload stays v1 with optional fields (executed: v1 plus extra fields opens unchanged).
- FLESH WOUND: receipts from the `seen` high-water marker report notes that were cut off, misaddressed or the sender's own as seen. Fixed: the `shown` table records what was actually returned; receipts and unseen read it.
- FLESH WOUND: a thread-filtered wait moved the marker past unrelated notes, so a third app's note was never delivered. Fixed by the same table: a wait marks only what it returned.
- Notes, all taken: dead-owner locks are stolen at once (Context corrected); the wait's write can hit `SQLITE_BUSY` (step 5); "cannot write" in Threat notes corrected; the hook id gate for Codex and Cursor stated; Cursor `sessionStart` marked best effort and `postToolUseFailure` added; `seen.host` column dropped with the marker; releases never count against the cap; the prune rule moved into Data; `NotesFile.open` is not read only, so the panel gets `openReadOnly`; `project_wait` under a redaction tier stated; canonical `to` invisible to pre-upgrade 0072 servers recorded as a limit; handshake names sourced to the call log.
- Residual, to verify on Jay's Mac before release: live Cursor and Codex hook runs (id formats, whether `sessionStart` context lands); each host's tolerance for a 25 s tool call (Claude Code's default MCP tool timeout is about 28 hours per its docs; Cursor and Codex unmeasured).

### Recheck (2026-10-21, same scripts plus r1 to r4, executed)

CLEARED WITH WOUNDS. Record: project files agent-messaging/adr-0079-recheck.md. All three review-1 findings closed by execution: a 0072 server reads a 1,000-character reply row and a 0079 claim and still refuses a duplicate claim; under the shown rule receipts exclude cut-off, misaddressed and own notes; a thread wait leaves an outside note unseen.

- FLESH WOUND (introduced by the fix): with the window for new readers only, a session that had been shown anything paged through the whole backlog five notes at a time. Fixed: the 24-hour window applies to every reader on every read (Data).
- Notes, taken: receipts exclude the sender's host, stated; Cursor `sessionStart` no longer writes `shown` rows; the one-time hook re-delivery after upgrade goes to KNOWN-LIMITS; orphan `shown` rows from 0072 builds stated with the 30-day trim; `openReadOnly` may create SQLite sidecar files, stated; the id gate minimum is 4 so `thr_123` passes; a wait returns already-pending notes at once; the panel sentence that claimed the mock was approved is corrected (it is built, not yet approved).
- The reviewer flagged that the fix round changed the approach (a new table and a new unseen rule) and that Jay decides whether that calls for a new first review rather than this recheck.
