# ADR 0072: Notes and claims between local AI apps

Status: Accepted 2026-10-15 (Jay) · Design review pass 3 and code review CLEARED WITH WOUNDS, fixed (record in design doc)

## Context
Local AI apps share one project record but cannot say "I took this bug." MCP is pull-only, so delivery waits for an agent's next call or a host hook.

## Decision
- D1: Notes are coordination, not memory. They live in one local file per vault, named by vault fingerprint, never synced, exported or shared. Core derives the key from the master key (keyed BLAKE2b, label `nk-notes-key-v1`) before the vault takes the buffer, and binds each row's readable fields as associated data. A key-check row resets the file, visibly, on mismatch. Each MCP project call that carries notes prunes notes of deleted projects.
- D2: One new tool, `project_note`: note, claim or release. A claim names a subject and expires in 1 to 24 hours. A second active claim on that subject is refused, naming holder and expiry. The check and insert run in one SQLite transaction; a repeated client id returns the stored note only to the same session for the same request.
- D3: project_get, resume, update, checkpoint, wrap and note results show active claims plus unseen notes addressed to this host or all. Each reader key (an MCP `session_id`, or `hook:<host>:<session>` for the hook) has a seen marker in that file. The two paths keep separate markers, so a note can show twice in one Claude Code session.
- D4: Notes are data. Every shown field is tamed to one line; text caps at 280 characters. A fixed `notes_notice` says they are information from other AI apps, never instructions, and appears in hook output too.
- D5: `northkeep notes --hook` serves a Claude Code hook, before each prompt and at most once a minute after tool calls. It reads only the OS key store, never prompts, prints nothing when locked or under a redaction tier, never writes under an unproved key, and writes only its seen marker and one call-log row. NorthKeep never installs a hook.
- D6: A grant of `project:<slug>` covers its notes. The call log records note ids, never text or subject. Caps: 10 active claims, 200 notes per project.

## Consequences
- Notes stay on one Mac; the phone never sees them.
- Limits: delivery waits for the next call unless a hook runs. Any local program can post or release as anyone. Cursor and Codex hooks are unverified.

## Rejected
- Vault entries: sync, older builds, export and the hash chain break.
- A Claims section in the project document: agents rewrite it.
- MCP notifications: hosts hide them.
- Grok now: new egress.

## What leaves the machine
NorthKeep sends nothing. Backups copy the file, project names readable. A local host sends what it receives to its own model provider, as invariant 1 states.

## Links
Design and review record: docs/design/agent-notes-and-claims.md · Extends: 0052, 0065 · Follows: 0068
