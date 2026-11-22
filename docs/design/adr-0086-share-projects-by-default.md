# ADR 0086 design record: share projects by default

## Origin
Jay, 2026-11-22: "I always want my projects shared"; "the switch should be there, and it should share everything. Then, agreed, you could unshare whatever you want"; and agents should ask at project creation instead of a separate button.

## Review 1 (fresh-eyes, against code, 2026-11-22): NOT CLEARED
1. HIGH. `project_update` with `expected_revision: null` creates a project (server.ts:1388, 1457; vault.ts:736), so a mark tied to `project_create` alone misses it. Fixed: D3 marks in `writeProject`'s creation branch; D4 adds `private` to both tools.
2. HIGH. Unshare deletes the `scopes` row (vault.ts:1968), so "Jay made this private" was indistinguishable from "never shared"; switch off-then-on, or delete-and-recreate, would re-share. Fixed: D5 `kept_private_projects` list, exported.
3. HIGH. The server's unshare deletes every row in the scope (neon-storage.ts:643), including app writes not yet pulled; an agent unshare tool could erase them. Fixed: tool dropped (D6, Rejected).
4. HIGH. Listing "every unshared project scope" would include deleted or memory-only scopes and, once Shared, apply cloud rows past the deleted-here check (connector-client.ts:618, 631, 648). Fixed: D2 lists only scopes with one live document and shows held-row counts.
5. MEDIUM. Memories written into a project scope before its document exists go when D3 marks it. Fixed: D2 and D4 report the count.
6. MEDIUM. `share add` honors `--yes` and `NORTHKEEP_ASSUME_YES` (shareCmd.ts:143), so shell-capable agents can share today. Fixed: the setting command needs a terminal and ignores both; KNOWN-LIMITS will say the existing limit.
7. MEDIUM. D3 is a second no-dialog exception to invariant #1. Fixed: CLAUDE.md amendment listed (needs Jay's OK), result line, D8 badge.
8. MEDIUM. A mark without a running push leaves the badge saying Shared while the cloud has nothing. Fixed: D4 reports the push state; Consequences say so.
9. LOW. Older builds ignore a `vault_meta` key; the export did not carry it; phone creation not covered. Fixed in D1, D3, Consequences.
10. LOW. Connector-created projects are folded or held, not always shared. Fixed: D3 defers to ADR 0050/0065.

Clean: checkpoint and wrap cannot create; `project_note` refuses unknown projects; `memory_forget` cannot delete a project document; `memory_remember` never marks; re-share after a tombstone passes the 412 check by fresh `shared_at`; auto-push never marks; D7 matches code.

## Recheck (2026-11-22): CLEARED WITH WOUNDS, wounds fixed
1. No NorthKeep importer exists (vault.ts:2087 export only; `import` reads ChatGPT and Claude). D1 now says export only.
2. `setScopeShared(false)` is also a failed-share rollback (api.ts:1108, shareCmd.ts:178); delete-project unshares (projectsApi.ts:239); the phone unshares via `saveMarks`. D5 names its writers, adds deletes, excludes rollbacks; phone gap in KNOWN-LIMITS.
3. The fold and take-theirs mark Shared with no list check (connector-client.ts:843, 948). D5: the fold holds listed scopes; any share by Jay clears the entry.
4. `projects import` creates through `importProject` (vault.ts:806), outside `writeProject`. D3: import stays private.
5. Held-row counts need the network (connector-client.ts:509). D2: "unknown" offline.

Clean: fold, restore and take-theirs use `replaceProjectContent`, not the creation branch; `writeProject` creation callers are exactly project_update, project_create, the app and the CLI; the mark shares the SQLite transaction; whole-blob vault sync gives the list no merge conflict.
