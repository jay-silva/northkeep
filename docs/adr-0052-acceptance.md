# ADR 0052 acceptance, as commands you can paste

The six acceptance steps of `SPEC/decisions/0052-project-provenance-and-session-accounting.md`,
written out as commands, plus the ADR 0051 addendum check that a compacted
revision keeps its writer block and the round-2 check that an injected
handshake name never reaches a reader. Everything runs against a throwaway
vault in a temporary home, so your real `~/.northkeep` is never opened.

Run the whole file top to bottom in one shell. The output under each step is
what this document's author got on 2026-09-21 on a clean temporary home, pasted
verbatim. Ids, session ids, timestamps and file paths differ every run. Byte
counts and revision counts differ too whenever the seeded content or the number
of writes above them changes, so read each step's stated invariant rather than
its exact numbers.

Two of the ADR's steps ask for two hosts. The CLI has no project commands, so
those steps run through `docs/adr-0052-acceptance.mjs`, which opens two
in-process MCP clients with different handshake names (`claude-code` and
`codex-mcp-client`) against the same vault, the way
`packages/mcp-server/test/server-tools.test.ts` does.

## Setup, once, at the top of the shell

Run these from the checkout you are reviewing, with its packages already built
(`pnpm -r build` if they are not).

```bash
export NORTHKEEP_HOME=$(mktemp -d)
export NORTHKEEP_PASSPHRASE='adr 0052 acceptance passphrase'
export NORTHKEEP_NO_KEYCHAIN=1
echo "$NORTHKEEP_HOME"
node packages/cli/dist/index.js init
```

Export `NORTHKEEP_HOME` once. A fresh `$(mktemp -d)` per command would give
every command an empty home and the steps would silently do nothing.

Successful output: a new directory path, then the two lines below with your own
temporary directory expanded in place of `$NORTHKEEP_HOME`,

```
✓ Vault created at $NORTHKEEP_HOME/vault.nkv
✓ Device secret generated at $NORTHKEEP_HOME/device.secret
```

followed by the device secret backup warning. Delete the directory when you are
done.

## Step 1: a wrap from one host, then a resume and a wrap from another

```bash
node docs/adr-0052-acceptance.mjs hosts
```

Successful output: the first host's name and session on the head, the second
host reading that same name back, then the second host's own name after its
wrap. The two session ids differ.

```
step 1 after the Claude Code wrap: last_writer.host = claude-code session_id = c75814ce-655c-4956-a047-2391fb6fae6b
step 1 Codex resume sees: last_writer.host = claude-code
step 1 after the Codex wrap: last_writer.host = codex-mcp-client session_id = 6c58d366-6c1a-42bc-9f24-f70fb0fb7b9d
```

## Step 2: the chain verifies, and an edited writer block breaks it

There is no `northkeep verify` command. `northkeep list` replays the chain and
prints the verdict on its last line, which is the same check.

```bash
node packages/cli/dist/index.js list --scope project:acceptance | tail -2
```

Successful output:

```
1 memory.
✓ Provenance chain verified.
```

Then edit a writer block in a copy of the vault. The copy is made, edited,
checked and deleted inside `$NORTHKEEP_HOME`; the original is not touched.

```bash
node docs/adr-0052-acceptance.mjs tamper
```

Successful output: the copy verifies, and after one field of the live head's
writer block is changed it does not. The block is inside `computeEntryHash`, so
the failure is the ordinary content hash failure, with no new mechanism.

```
step 2 copy before the edit: chain ok = true
step 2 copy after editing the live head writer block: chain ok = false
step 2 reported: Entry 04a17e5e-7c68-4e1a-a481-b28fabd5d0d6 hash does not match its content.
step 2 an unrelated metadata key instead: Entry 04a17e5e-7c68-4e1a-a481-b28fabd5d0d6 hash does not match its content.
```

Read that last line as the limit of the step. The hash covers the whole row, so
an unrelated metadata key fails with the identical message. What this proves is
that the writer block cannot be changed without breaking the chain, not that the
chain says which field moved.

Run `node docs/adr-0052-acceptance.mjs compacted` after step 4, when the
project has compacted revisions to look at. It is written up below as step 2c.

## Step 3: a session that read and never wrote back

```bash
node docs/adr-0052-acceptance.mjs open
```

Successful output: one open session, named by the host that read, with the time
of that read and the fixed note. A session never lists itself.

```
step 3 Claude Code read revision 04a17e5e-7c68-4e1a-a481-b28fabd5d0d6 and wrote nothing
step 3 open session: claude-code 3127825d-9d34-448c-b9a9-eff03a34577d last read 2026-09-21T20:51:33.558Z
step 3 note: These sessions read this project and did not write back. Nothing was recorded on their behalf.
```

## Step 4: the default resume brief is small, and one revision reads in full

The ADR measures this at the cap, `PROJECT_DOC_MAX_CHARS`, 16,384 characters,
rather than on whichever project happens to be small today. This step writes 25
log updates on the project from step 1 and then grows What & Why until the
document sits exactly at the cap.

```bash
node docs/adr-0052-acceptance.mjs payload
```

Successful output: a document at the cap, a default payload under 24,576 bytes
carrying only content-free summaries and no history, a much larger payload with
`history: true`, one old revision read back in full, and the same measurement
for a document at the same cap made of CJK characters.

```
step 4 ASCII document at the cap: 16384 characters, 16384 bytes
step 4 default resume payload, ASCII at the cap: 20083 bytes, target under 24576
step 4 invariants: content key = false | files_text key = false | any revision carries text = false | history entries = 0
step 4 revisions carried: 8 summaries
step 4 with history: true: 31009 bytes
step 4 one revision read: 3aff0edf-6966-4b6f-86e9-d5ac89bd560c is 1946 characters of text
step 4 CJK document at the cap: 16384 characters, 48862 bytes
step 4 default resume payload, CJK at the cap: 49974 bytes
step 4 CJK invariants: content key = false | files_text key = false | any revision carries text = false
```

The byte counts are not the check. They move with the seeded content, with how
many log updates ran above them, and with how many revisions compaction left,
so a rerun that prints different numbers has not failed. What is invariant, and
what the step prints as `invariants`, is this: the default brief carries no
`content` key, no `files_text` key, no revision text inside its summaries, no
`history`, and for an ASCII document at the cap a payload under 24,000 bytes,
inside the ADR's 24 KB target.

The CJK line is reported, not claimed. The cap counts characters and the 24 KB
target counts bytes, so a document at the cap made of three-byte characters is
48,862 bytes of text and its default brief is 49,974 bytes, well past the
target. The ADR states the bound as bytes against a character cap; this is what
that gap measures. Nothing here is fixed by this document.

Eight summaries rather than five: ADR 0051 compaction keeps the newest five plus
any revision a handoff receipt still names, and the two wraps in step 1 left
three such revisions.

To measure the real `northkeep` project, do it as a read and nothing else: one
`project_resume` with defaults from any connected host, and count the bytes of
what comes back. Do not run this step's script against your own home; it writes
26 updates and creates a second project, which would make a real project's
history.

## Step 4b: an injected handshake name never reaches a reader

A handshake name is host-supplied, so a client can present one carrying U+0085,
U+2028, U+2029, a zero-width character or a bidi override, none of which the
server's control-character filter strips. Whatever a reader sees in the writer
block must carry none of them.

```bash
node docs/adr-0052-acceptance.mjs injected
```

Successful output: either the write is refused as `invalid_request`, because
the server passed the raw name through and `validateProjectWriter` refused it,
or the server tamed the name first and the write lands under the clean name.
The step prints which happened. Either way the last line is `false`.

```
step 4b create refused: invalid_request | the server passed the raw name through and core refused it
step 4b project_get on that project: not_found
step 4b writer block carries a forbidden character: false
```

On this branch the server tames only `[\x00-\x1f,"]`, so U+0085 survives the
handshake and core refuses the write with zero mutation: the project is never
created, which is why `project_get` reports `not_found`.

## Step 2c: a compacted revision keeps its writer block and nothing else

The ADR 0051 addendum. Again on a copy, made and deleted inside
`$NORTHKEEP_HOME`.

```bash
node docs/adr-0052-acceptance.mjs compacted
```

Successful output: blanked revisions with no text left, each still naming the
host and session that wrote it, carrying that one metadata key and no other, and
a chain that verifies. Smuggling a second key onto a blanked row fails
verification.

```
step 2 superseded revisions: 28 of which blanked: 20
step 2 oldest blanked revision 84032504-2d52-4083-a3e9-f7350c582fe4 keeps host claude-code session 9573e680-5da8-48d1-854f-aacb1452b25c | text length 0
step 2 metadata keys on that row: northkeep_provenance_v1
step 2 chain with the kept blocks: ok = true
step 2 after smuggling a second key onto that blanked row: ok = false
step 2 reported: Forgotten entry 84032504-2d52-4083-a3e9-f7350c582fe4 carries metadata beyond its writer block.
```

The arithmetic, which moves with step 4: 29 writes on `acceptance` (a create,
two wraps, 25 log updates and the one update that fills the document to the
cap) leave 28 superseded revisions, 8 keep their text (the newest five plus the
three the two handoff receipts name), so 20 are blanked. The row named above is
the oldest of them, which is the one that has been compacted longest.

What this check does not cover: a blanked row has no content left, so its entry
hash cannot be recomputed, and swapping one well-formed host or session id for
another well-formed one on a blanked row is not detectable. Step 2 covers a live
revision, where the hash does cover the block.

## Step 5: a draft project, cleared by a wrap, and no second create

```bash
node docs/adr-0052-acceptance.mjs draft
```

Successful output: the draft line opens the document, the list reports the
project as a draft, the wrap removes the line, and a second create of the same
slug is refused.

```
step 5 created draft: true | first line: Draft, unverified: bootstrapped by claude-code on 2026-09-21.
step 5 list shows draft: true
step 5 after the wrap, draft: false | first line: ## What & Why
step 5 second create refused: true | stale_project
```

## Step 6: the installed contract reports stale

```bash
node packages/cli/dist/index.js contract status
```

This one command ignores `NORTHKEEP_HOME`: an installed contract is a host's own
configuration file, so the check reads the real `~/.claude` and `~/.codex`. It
reports on your machine, not on the temporary vault. On a machine with no
contract installed it says `not installed` instead.

Successful output on the author's machine:

```
NorthKeep contract status
  Claude Code            stale       /Users/jsilva/.claude/rules/northkeep-projects.md
  Codex                  stale       /Users/jsilva/.codex/AGENTS.md
  Cursor (this project)  (pass --project <dir> to check a project rule)

This contract does not reach Claude Desktop plain chat or ChatGPT chat. Those surfaces have no on-disk instruction file.
```

Installing the new contract is your action, not the tool's:
`node packages/cli/dist/index.js contract install`.

## Extra: what is left to compact

```bash
node packages/cli/dist/index.js projects compact
```

Successful output: a per-project table and nothing to do, because automatic
compaction already bounded history at every write. The row count follows
whatever the steps above created. This is a dry run; `--yes` would compact.

```
Project                    Revisions  Kept  To blank         Bytes
acceptance                         8     8         0             0
acceptance-cjk                     1     1         0             0
bootstrapped                       1     1         0             0
Total                                              0             0

Dry run: nothing changed. Add --yes to compact.
```

## Clean up

```bash
rm -rf "$NORTHKEEP_HOME"
unset NORTHKEEP_HOME NORTHKEEP_PASSPHRASE NORTHKEEP_NO_KEYCHAIN
```
