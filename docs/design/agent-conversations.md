# Design record: conversations between local AI apps (ADR 0079)

Extends the notes file and rules of ADR 0072 (docs/design/agent-notes-and-claims.md). Everything here stays on one Mac.

## Data

Payload v2 (packages/core/src/project-notes.ts):

```ts
interface NotePayload {
  v: 1 | 2;
  kind: 'note' | 'claim' | 'release';
  host: string;        // canonical app name, tamed
  text: string;        // one line, up to 1,000 characters
  to: string;          // canonical app name or 'all'
  subject?: string;    // claims only
  expires_at?: string; // claims only
  releases?: string;   // releases only
  reply_to?: string;   // v2 notes only: the note answered
  thread?: string;     // v2 notes only: the root note's id
}
```

Rows, blobs, associated data and the key-check row are unchanged, so a 0072 build reads v2 rows (it ignores the two new fields) and a 0079 build reads v1 rows. A reply must name an existing note of the same project; `thread` is copied from the parent (or is the parent's id when the parent is a root). A reply to a claim or release is allowed; a claim or release is never itself a reply. Replies address the parent's sender host by default (`to` may still be set).

The `seen` table gains `host TEXT NOT NULL DEFAULT ''` (the reader's canonical name). Receipts: a note is seen by host H when any `seen` row with that host has `last_seq >= note.seq`. Shown as `seen_by: string[]` on every note view inside a thread.

Canonical app names (packages/core/src/project-notes.ts, one table):

| reported by the app | canonical |
|---|---|
| `local-agent-mode-northkeep` | `claude-desktop` |
| `claude-ai` | `claude-desktop` |
| `claude-code` | `claude-code` |
| `cursor-vscode`, `cursor` | `cursor` |
| `codex-mcp-client`, any name starting with `codex` | `codex` |
| `northkeep-app`, `northkeep-cli` | `northkeep` |

Unknown names pass through `tameHost` unchanged. The table is applied when a note is stored, when `to` is parsed, and when a reader's host is compared, so old rows with raw names still match.

## Tools

`project_note` gains `reply_to` (a note id). Result adds `thread` and `seen_by`.

`project_wait` (new):

```
project_wait({ project, seconds?: 1..25 (default 20), thread?: noteId })
→ { notes, notes_count, active_claims, notes_notice, waited_ms }
   or { timed_out: true, waited_ms }
```

Steps: (1) inside the ordinary `run` envelope, a short vault call checks the grant and that the project exists, and derives the notes key; (2) the vault and its file lock are released; (3) the server polls `SELECT MAX(seq) FROM notes WHERE project = ?` every 500 ms, decrypting only when the sequence moves; (4) on a new note for this reader (to this host or all, not its own; inside `thread` when given) it builds the 0072 notes block, marks seen, logs ids and returns; (5) after `seconds` it returns `timed_out`. The key is wiped on every exit path. The call log gets one pending row before the wait and one done row after it, like every tool.

Why outside the lock: `withFileLock` (packages/core/src/lock.ts) is advisory and stolen after 60 s; every other app's project call waits on it for at most 5 s and then fails. A wait inside it would turn one agent's patience into every other agent's failure.

Caps per MCP session, counted in the server process: 30 waits per hour (`wait_budget_exhausted`), 60 notes per hour (`too_many_notes`). Both are refusals with the time the budget resets. They exist so two agents cannot loop at the user's token cost, not as security.

## Hooks (three hosts, one command)

`northkeep notes --project <slug> --hook --host <claude-code|codex|cursor> [--min-interval 60]`

| host | stdin id field | events the hook accepts | output |
|---|---|---|---|
| claude-code | `session_id` | `UserPromptSubmit`, `PostToolUse` | `{"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}}` |
| codex | `session_id` | `SessionStart`, `UserPromptSubmit`, `PostToolUse` | same as claude-code |
| cursor | `conversation_id` | `sessionStart`, `postToolUse` | `{"additional_context": …}` |

Reader key stays `hook:<host>:<id>`. Everything else in 0072 D5 holds: key store only, never the vault, nothing under a redaction tier, exit 0 always, one call-log row. Cursor's `beforeSubmitPrompt` is not used because it has no context output (cursor.com/docs/agent/hooks, read 2026-10-21). Codex hooks are on by default in 0.159 and must be trusted once through `/hooks` (learn.chatgpt.com/docs/hooks, read 2026-10-21).

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

`GET /api/projects/<slug>/notes` on the local web server (apps/web/src/projectsApi.ts) returns threads newest first: each root note with its replies in order, canonical names, `seen_by`, and active claims. The server opens the notes file with the session's key, `resetOnMismatch: false`, read only; on a mismatch it returns `{ unreadable: true }` and the page says the notes file cannot be read. The project page shows a Conversation section under the milestones: one card per thread, replies indented, claims as a short list above. No input, no actions. Mock at 390 px and 1280 px first; Jay approves the mock before the panel is built.

## Threat notes

- A reply is text from another local program, like a note. The notice is on every result and hook output; `project_wait` results carry it too.
- Any local program can still post as any app (0072 limit). Canonical names do not change that; they only make the names readable.
- A wait reads only; it cannot hold the vault, cannot write, and ends by itself.
- The panel is loopback only and reads only; the browser cannot post.

## Tests

- core: thread building, reply validation, canonical names, receipts, prune never drops a thread root that has active replies within the window.
- mcp-server: reply round trip between two sessions; wait returns on a reply and times out otherwise; wait while another session holds the vault lock (must still return); caps.
- e2e (real processes): Cursor asks, Claude Code replies, Cursor's wait returns the reply with `seen_by: ['cursor']` absent and `['claude-code']` present after Claude's read; the hook prints Cursor's shape and Codex's shape from recorded stdin.
- web: the notes route returns threads and refuses a locked session.

## Acceptance (Jay, after merge)

1. Cursor: "Use NorthKeep project_note to tell claude-desktop: are you in vault.ts? Then project_wait for a reply."
2. Claude desktop: "Run project_resume for northkeep and reply to Cursor's note with project_note reply_to."
3. Cursor's wait returns the reply inside the same turn.
4. The Mac app's project page shows the thread with both names.
5. Hooks: with the Codex and Cursor recipes installed, a note from Claude desktop shows in each after its next tool call.

## Reviews

Pending.
