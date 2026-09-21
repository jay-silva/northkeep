# ADR 0052 acceptance, as commands you can paste

The six acceptance steps of `SPEC/decisions/0052-project-provenance-and-session-accounting.md`,
written out as commands, plus the ADR 0051 addendum check that a compacted
revision keeps its writer block. Everything runs against a throwaway vault in a
temporary home, so your real `~/.northkeep` is never opened.

Run the whole file top to bottom in one shell. The output under each step is
what this document's author got on 2026-09-21 on a clean temporary home, pasted
verbatim. Ids, session ids and timestamps differ every run; nothing else should.

Two of the ADR's steps ask for two hosts. The CLI has no project commands, so
those steps run through `docs/adr-0052-acceptance.mjs`, which opens two
in-process MCP clients with different handshake names (`claude-code` and
`codex-mcp-client`) against the same vault, the way
`packages/mcp-server/test/server-tools.test.ts` does.

## Setup, once, at the top of the shell

```bash
cd ~/Claude/Projects/NorthKeep/northkeep
pnpm -r build
export NORTHKEEP_HOME=$(mktemp -d)
export NORTHKEEP_PASSPHRASE='adr 0052 acceptance passphrase'
export NORTHKEEP_NO_KEYCHAIN=1
echo "$NORTHKEEP_HOME"
node packages/cli/dist/index.js init
```

Export `NORTHKEEP_HOME` once. A fresh `$(mktemp -d)` per command would give
every command an empty home and the steps would silently do nothing.

Successful output: a new directory path, then

```
✓ Vault created at /var/folders/.../T/tmp.AXyoI58bAs/vault.nkv
✓ Device secret generated at /var/folders/.../T/tmp.AXyoI58bAs/device.secret
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
step 1 after the Claude Code wrap: last_writer.host = claude-code session_id = 52ef188a-fbf8-44d7-90ea-449c7d112f82
step 1 Codex resume sees: last_writer.host = claude-code
step 1 after the Codex wrap: last_writer.host = codex-mcp-client session_id = 486ffab4-5c96-4578-9642-71cb23d148bd
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
step 2 reported: Entry b916e812-8311-4169-833f-a3c2dce95646 hash does not match its content.
```

Run `node docs/adr-0052-acceptance.mjs compacted` after step 4, when the
project has compacted revisions to look at. It is written up below as step 2c.

## Step 3: a session that read and never wrote back

```bash
node docs/adr-0052-acceptance.mjs open
```

Successful output: one open session, named by the host that read, with the time
of that read and the fixed note. A session never lists itself.

```
step 3 Claude Code read revision b916e812-8311-4169-833f-a3c2dce95646 and wrote nothing
step 3 open session: claude-code 47c6cbd4-0bb4-4d49-9bf9-bdeea168fac1 last read 2026-09-21T19:23:06.489Z
step 3 note: These sessions read this project and did not write back. Nothing was recorded on their behalf.
```

## Step 4: the default resume brief is small, and one revision reads in full

The ADR measures this on the real `northkeep` project, which does not exist in a
temporary home. This step makes a comparable one instead: 25 log updates on the
project from step 1. The number to compare against Jay's real vault is the 24 KB
target, not the exact byte count.

```bash
node docs/adr-0052-acceptance.mjs payload
```

Successful output: a default payload well under 24,576 bytes carrying only
content-free summaries and no history, a much larger payload with
`history: true`, and one old revision read back in full.

```
step 4 default resume payload: 7668 bytes, target under 24576
step 4 revisions carried: 8 summaries, history entries: 0
step 4 with history: true: 18244 bytes
step 4 one revision read: 424bc2bf-7b70-4e8d-a2c9-08e1127ddf08 is 1877 characters of text
```

Eight summaries rather than five: ADR 0051 compaction keeps the newest five plus
any revision a handoff receipt still names, and the two wraps in step 1 left
three such revisions.

To measure the real project instead, run the same call against your own home
rather than the temporary one. That measurement is yours to make; this document
does not open `~/.northkeep`.

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
step 2 blanked revisions: 19 | first one keeps host claude-code session 504f2135-631b-47b5-af58-d52fe9ddde0d | text length 0
step 2 metadata keys on that row: northkeep_provenance_v1
step 2 chain with the kept blocks: ok = true
step 2 after smuggling a second key onto that blanked row: ok = false
step 2 reported: Forgotten entry cf967f9a-38a4-445a-853c-75bca4e4ae8d carries metadata beyond its writer block.
```

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
```

Installing the new contract is your action, not the tool's:
`node packages/cli/dist/index.js contract install`.

## Extra: what is left to compact

```bash
node packages/cli/dist/index.js projects compact
```

Successful output: a per-project table and nothing to do, because automatic
compaction already bounded history at every write. This is a dry run; `--yes`
would compact.

```
Project                    Revisions  Kept  To blank         Bytes
acceptance                         8     8         0             0
bootstrapped                       1     1         0             0
Total                                              0             0

Dry run: nothing changed. Add --yes to compact.
```

## Clean up

```bash
rm -rf "$NORTHKEEP_HOME"
unset NORTHKEEP_HOME NORTHKEEP_PASSPHRASE NORTHKEEP_NO_KEYCHAIN
```
