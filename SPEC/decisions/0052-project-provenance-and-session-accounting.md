# ADR 0052: Project provenance, session accounting, a lighter resume brief, and draft projects

- **Date:** 2026-09-21
- **Status:** Proposed. Jay chose wave 1 ("M-C+E and M-F together") on
  2026-09-21 after the migration-prerequisite scoping. Adversarial review
  runs against the merged branch before the claims below are published.
- **Deciders:** Jay (product owner), Claude Code
- **Extends:** ADR 0039 (projects as vault memories), ADR 0042 (contract
  installer), ADR 0045 (log rolling), ADR 0048 (handoff receipts),
  ADR 0051 (compaction, chain verification)
- **Does not touch:** egress, redaction, crypto or key handling, the
  connector, sync, the row envelope. No model runs in any path here. No
  new dependency. The CLAUDE.md gate is tripped only by the claims in the
  last section, which is why the review is against the merged artifact.

## Context

A month of the hand-built command repo showed that agents are
indistinguishable in the record (199 of 200 commits carry one human
name), that a session which reads a project and never writes back is
undetectable, and that the contract is trusted rather than structural.
The content-free MCP call log already captures each client's handshake
name (`claude-code`, `codex-mcp-client@<ver>`, `cursor-vscode`,
`grok-shell-northkeep`, `claude-ai`), but nothing in the vault does. The
call log also shows that in 2.5 months no real host has called
`project_wrap` or `project_checkpoint` (0 each), `project_resume` twice,
and `project_update` 341 times, because the installed contract says
`project_get` and `project_update` and because a default `project_resume`
returns up to twenty full prior revisions plus every archive, tens of
thousands of tokens for one read.

No MCP host exposes a model identifier in its handshake. Recording one
would be a guess, and the owner ruled guesses out.

## Decision 1: Provenance metadata on every project document write

Every write of a project working document through the project tools
(`project_create`, `project_update`, `project_checkpoint`,
`project_wrap`, and the web app's update, checkpoint and wrap) stores a
reserved metadata block on the new head:

```
northkeep_provenance_v1: {
  version: 1,
  host: string,            // handshake name, sanitized, 1..80 chars
  host_version: string | null,   // handshake version, up to 40 chars
  model: null,             // no host exposes one; never guessed
  session_id: string,      // lowercase RFC 4122 v4, minted per server process
  recorded_at: string      // ISO time of the write
}
```

The block is written from a caller-supplied `writer` on the request
(`{ host, host_version?, session_id }`), validated in core, and never
inherited from the previous head: a write without a writer carries no
block. Metadata is inside `computeEntryHash`, so the block is
tamper-evident under the existing chain verification with no new
mechanism. It is not part of the handoff request fingerprint, so an exact
retry from the same operation id still returns the original receipt.
Receipt validation and compaction ignore the key. The `source` column is
unchanged; receipts pin it.

A generic edit of a project head (`memory_edit`, ADR 0015 supersession)
copies metadata verbatim by design. It now strips the provenance block
and only that block, because a revision minted by a generic edit is not
the previous session's write and must not be attributed to it. The
handoff receipt still copies, as ADR 0048 requires.

`ProjectView` gains `last_writer` (the head's block, or null) and
`ProjectSummary` gains `last_writer_host`. Malformed blocks read as null.

## Decision 2: A session id on every call, and open sessions derived, not stored

The MCP server mints one session id per process at `createServer` and
writes it on every call log row (`session_id`) and into every provenance
block. Resume stays a read: nothing is written to the vault when a
project is opened.

An open session is derived from the call log at resume time: a session
id that read the project (`project_get` or `project_resume`) within the
last 30 days and has no successful write to the same project
(`project_update`, `project_checkpoint`, `project_wrap`) after that read,
excluding the current session. Rows without a session id (older than this
ADR) are skipped. `project_resume` returns the newest three as
`open_sessions: [{ session_id, host, opened_at, last_read_at }]` with a
fixed note that nothing was recorded on their behalf. No auto-wrap, ever.

The call log is per machine and the hosted connector never touches it,
so hosted sessions are invisible here. Stated in KNOWN-LIMITS.

## Decision 3: The default resume brief is small; everything else is one call away

`project_resume` defaults `history` to false. The view always carries
`revisions`, the newest twenty prior revisions as summaries (`id`,
`updated_at`, `mode` when a receipt names one, `writer` host and session
when present, `chars`) with no content, and `archive_summary`
(`{ count, oldest, newest }`). `history: true` still returns full
revision text and archives as today. `project_get` gains an optional
`revision` argument that returns one prior revision in full, refused
outside the project's scope. Target: the default resume payload for the
busiest real project stays under 24 KB; the acceptance test measures it.

## Decision 4: Draft projects

`project_create` gains `draft: boolean`. A draft document opens with one
preamble line, `Draft, unverified: bootstrapped by <host> on <YYYY-MM-DD>.`,
host from the writer or `unknown host`. `ProjectView` and
`ProjectSummary` gain `draft`. The line is removed by a `project_wrap`
(a human-closed session) or by `project_update` with `draft: false`.
`project_checkpoint` and other updates keep it. `draft: true` on an
existing document is refused as `invalid_request`; a second create of the
same slug is already refused.

## Decision 5: The contract changes two paragraphs, and Jay installs it

The standing instruction prefers `project_resume` at session start and
`project_wrap` at session end, with `project_checkpoint` mid-session and
`project_update` for corrections outside a session. A second paragraph,
the bootstrap recipe, tells the host agent how to build a project from a
codebase: README first, then the newest 30 commits, then CHANGELOG, ADR
and docs folders, then build files; date every status claim "as of
<date>", mark inferences "unverified", never run the code, fetch URLs, or
read `.env` or secrets; keep the document under 6,000 characters with
detail in one episodic memory per source; then `project_create` with
`draft: true`. No model runs inside NorthKeep for this; the host agent
already has the repository open.

Installed contract files are agent-read configuration. The installer
reports existing installs as stale; writing them is Jay's action.

## Token discipline (cross-cutting, owner constraint 2026-09-21)

Every read tool's default payload is measured before and after in the
acceptance test. A change that grows a default read fails acceptance.

## Claims this ADR publishes

1. Every project write through the project tools records its
   host-reported writer, and that record is tamper-evident once written.
   Host-reported: any process can present any handshake name. The claim is
   attribution plus integrity, never verified identity.
2. A session that read a project on this machine and never wrote back is
   visible at the next resume. Per machine; hosted reads are not seen.
3. No model identity is ever recorded. `model` is null until a host
   exposes one through the handshake.

## Acceptance (Jay, from the CLI and two hosts)

1. Wrap a disposable project from Claude Code, then resume from Codex:
   the brief shows `last_writer.host` `claude-code` with a session id,
   then after a Codex wrap shows `codex-mcp-client`.
2. `northkeep verify` passes; edit a provenance block in a copy of the
   vault and verify fails.
3. Resume from Claude Code and quit without writing; resume from Codex:
   `open_sessions` lists the Claude Code session id and time.
4. `project_resume` on `northkeep` with defaults: payload under 24 KB.
   `project_get` with a `revision` id returns that old text in full.
5. Create a project with `draft: true`: the list shows it as draft; wrap
   it once; draft is gone; create the same slug again: refused.
6. `northkeep contract status` reports the installed contract stale.

## Adversarial review

Pending, against the merged branch.

## Implementation notes

Tool arguments added in `packages/mcp-server/src/server.ts`:

- `project_create` gains `draft` (boolean, optional). True opens the
  document with the draft preamble line, naming the writing host and the
  date. `project_wrap` clears it, as does `project_update` with
  `draft: false`.
- `project_get` gains `revision` (memory id, optional). It returns that one
  earlier working revision in full instead of the current document, after
  the connection grant is asserted here and again in core. A revision in
  another project's scope reads as `not_found`, and a compacted revision
  says its text is gone.

No other tool gained an argument. `project_update`, `project_create`,
`project_checkpoint` and `project_wrap` all pass the connection's handshake
name, handshake version and session id as the request `writer`; nothing
about the model is sent, because nothing about the model is known.

Measured payloads (`packages/mcp-server/test/server-tools.test.ts`,
2026-09-21, a project with 25 updates, 20 of them small, and 3 Log
archives; bytes of the tool result text as it goes over the wire):

- `project_resume` with defaults: 10,556 bytes, under the 24 KB target,
  carrying `revisions` (5 content-free summaries, the rest having been
  compacted away by ADR 0051's automatic keep of 5), `archive_summary`,
  `last_writer` and `draft`, and no prior revision text.
- The same call with `history: true`: 84,738 bytes, eight times larger, and
  it does contain the prior revision text.

Tier-1 masking treats `host`, `host_version`, `recorded_at` and the archive
summary stamps as identifiers, so a host name shaped like an address still
reads back verbatim under `NORTHKEEP_REDACT_TIER=1`.
