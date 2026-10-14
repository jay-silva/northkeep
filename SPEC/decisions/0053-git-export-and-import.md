# ADR 0053: Git export and import for project documents

Status: Accepted for build (M-A1, local mirror) 2026-09-22, after draft reviews NOT CLEARED and Jay's "Split it" (push moved to ADR 0055, draft). Code review NOT CLEARED, recheck CLEARED WITH WOUNDS, both wounds fixed after, no later recheck. Ships first in 0.22.0. No owner acceptance run recorded apart from step 10.

## Context
Jay wants a human-readable, git-versioned backup of project documents, exported on demand into a NorthKeep-owned folder, plus import of an existing Markdown folder.

## Decision
- D1: The mirror holds `projects/<slug>.md`, numbered `projects/<slug>.log.<n>.md`, `INDEX.md` and a `.northkeep-mirror` marker naming vault and mirror id. An unchanged vault gives byte-identical files and no commit.
- D2: Git never touches the working tree: a private temporary index, `hash-object --no-filters`, `commit-tree`, `update-ref` with an old value. Verbs are allowlisted: no `push`, `fetch`, `ls-remote`, `add` or `commit`. Fixed env (no system or global config, `GIT_NO_REPLACE_OBJECTS=1`), owned empty hooks path, `-c` pins for program keys. Git 2.31+.
- D3: A file is ours only if its header names this vault and its blob is in the journal (last ten blob ids per path, keyed by mirror id). Anything else is a hand edit: refused, never overwritten or committed.
- D4: The user runs `git init` on an empty folder; `northkeep projects export --repo <path>` writes the marker. NorthKeep writes only `projects/`, `INDEX.md` and the marker. Every project is exported; no exclusion (ADR 0055).
- D5: `--verify` writes nothing in the repository or `NORTHKEEP_HOME` (it uses a throwaway temp git home). `--status` names any remote with "NorthKeep never pushes; a push you make publishes the mirror". The resume line never runs git and counts only granted scopes.
- D6: `--schedule hourly|daily [--at HH:MM]|off`, macOS launchd, off by default; never prompts; records `vault_locked` without the parked key.
- D7: `northkeep projects import --from <dir> [--write]`, dry run by default, no git; strict UTF-8; refuses a scope with any live entry; 60,000-byte rows.

## Consequences
- Limits: plaintext project content now sits on disk, mode 0644, at a path the user chose (KNOWN-LIMITS amended). The pins are a list a future git could outgrow. A directory swapped between `lstat` and write is not closed. On journal loss export refuses every file while verify still says `matches`. Archives beyond 20 are not mirrored. Log direction is inferred; earlier imports keep the old shape.

## Rejected
- Porcelain git: `add` and `diff` ran a clean filter over plaintext.
- Automatic export after writes; adopting a hand-written repository.

## What leaves the machine
The mirror path sends nothing: no network verb exists. The mirror is as off-machine as Time Machine or a push the user makes; that push is their egress. `projects import --write` and `projects delete` save the vault and then run the existing ADR 0044 ciphertext push when sync is configured and the key came without a prompt; `projects export` never does.

## Links
Extends: ADR 0039, 0045, 0048, 0051, 0052 · Push: ADR 0055

Full record: docs/design/adr-0053-git-export-and-import.md
