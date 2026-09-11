# Final upgrade adversarial review

**Target:** `be125023e8fb40a7338b7a5f254158d0efee3ba5` versus public `0.21.0` / `74cb81f9986b0bf10452562f5eab602192b32dc3`

**Rules loaded:** authoritative Agent Rules `2026-09-07.1` and `Agent security.md` from Jay's Mac.

**Final release verdict: CLEAR WITH LIMITS.** The current implementation is clear for a fresh process and the vault format remains compatible. The release now carries an explicit, prominent manual control for the upgrade transition: save work; fully quit NorthKeep and every local MCP host before installation; reopen them afterward; verify the three new handoff tools and the revision-bound `project_update` schema; then perform a read-only Resume before allowing writes. A connection that still exposes the old or unknown schema is told to stop. This resolves the release blocker without claiming that the updater forcibly retires older processes.

## Findings

### F1 — Medium, mitigated for release: a pre-update MCP process can keep writing with the old project semantics

The new server requires `expected_revision` for `project_update` (`packages/mcp-server/src/server.ts:590-657`). A call that reaches a new process without that field is rejected during schema validation, so that direction fails safely.

The reverse direction is the problem. The public `0.21.0` server accepts `project_update` without a revision, reads the newest live document at write time, merges replacement sections, and saves it (`origin/main:packages/mcp-server/src/server.ts:569-639`). A running Node process keeps those old modules in memory after the app bundle is replaced. Current self-retirement only occurs after `VaultSchemaError` (`packages/mcp-server/src/server.ts:158-164`, `770-775`), while this release deliberately keeps schema `0.4`. The process otherwise exits only when its client closes stdin or sends a termination signal (`786-819`).

Impact: if Claude Desktop, ChatGPT, Cursor, or another local MCP host stays open across installation, its old server can still replace Status, Next Actions, or What & Why without presenting an expected revision. Log and Decisions append, and superseded vault history remains, so this is recoverable rather than silent physical deletion. It can nevertheless overwrite the currently presented project state and makes the release claim about stale-write refusal false for that still-running connection.

Reproduction path from code:

1. Start the `0.21.0` local MCP server and keep the client connection open.
2. Replace the installed app with this build; do not restart the client.
3. Save a newer project revision through the new UI or a fresh MCP process.
4. Call the old process's cached `project_update` schema with replacement Status or Next Actions.
5. The old handler reopens the same schema-compatible vault, selects the newest head, applies the unversioned replacement, and saves. No `VaultSchemaError` occurs, so it does not self-retire.

Release control now present: `docs/update-memory-projects.md` requires a full shutdown before installation, explicitly includes NorthKeep, Claude Desktop, Codex, Cursor and terminal assistant sessions, says Close Window is insufficient, requires fresh tool/schema discovery and a read-only Resume, distinguishes the hosted connector, and blocks writes from an old or unknown connection. `KNOWN-LIMITS.md` places the same limitation at the top of Local Projects. The Projects acceptance record states that the updater does not automatically terminate older processes. A code-enforced protocol/build-version retirement remains a stronger future improvement.

### F2 — Low, resolved: documentation now connects restart to the new safety guarantee

The owner-checkout `KNOWN-LIMITS.md`, dedicated update guide, Projects acceptance boundary, all three Markdown communication drafts, and their rendered HTML now state or link the restart prerequisite. Claims about stale-write refusal are explicitly scoped to connected assistants restarted on the new local tools. The founder update and website tell users to fully quit before installing and verify after reopening; the short post qualifies the claim as applying after restart.

No other materially false upgrade or privacy claim was found in `post.md`, `founder-update.md`, `website-copy.md`, or their rendered HTML. Their current-version labeling, local-versus-hosted distinction, file-reference qualification, review-before-save wording, unchanged vault-format statement, and Converse/history transition wording match the reviewed code and diff.

## What held under attack

- Current local project writes bind the exact revision inside the file lock, perform archive/head/supersede changes in one SQLite transaction, and save once. Stale and duplicate-head refusals leave the exported memory set and chain head unchanged.
- Checkpoint/wrap operation IDs bind the canonical validated request. Exact retries return the original receipt even after a later edit; altered reuse, malformed/copied/forgotten receipts, invalid lineage, and altered archive payloads fail closed.
- Review actions persist a prepared receipt before vault save and reconcile it as committed or aborted on retry. Restoration requires the recorded head and content and refuses later edits.
- Consolidation accepts only 2-8 exact same-scope/type private non-project snapshots. Apply and restore use persisted request/lineage validation; shared-state or source changes refuse. Originals remain in encrypted superseded history, and restoration creates linked copies rather than pretending to reverse later work.
- New `/api/projects/*` and `/api/curation/*` handlers are reached only through the existing HTTP server session-token gate and independently refuse a locked vault. Project MCP writes retain scope-grant enforcement. No new hosted route or connector project implementation is introduced by the diff.
- No vault schema, encryption primitive, or key-handling format changes. New consolidation and handoff state is hash-covered metadata in existing entries. The existing compatibility test covers a `0.21.0` core-created vault opened/saved after consolidation and restoration; the old core treats the metadata as opaque.
- Shared/local boundaries remain as stated: local save may trigger the already-approved automatic sync path, but the receipt claims only local durability. Hosted connector writes and whole-vault multi-device conflict behavior remain unchanged.

## Verification performed

All project execution used the mandated empty environment, disposable `HOME`/`NORTHKEEP_HOME`, and `NORTHKEEP_NO_KEYCHAIN=1`. No live vault, credential, Keychain, connector, model, production service, or external network call was used.

- Targeted current-code tests: **67 passed** across core project handoff, consolidation, review session/crash recovery, local MCP tools, and web project/curation job handlers.
- TypeScript validation: core, librarian, MCP server, web, and CLI all passed `tsc --noEmit`.
- Parent verification after this review: the exact 12 loopback HTTP cases passed in this same isolated worktree under the mandated empty environment and disposable storage: consolidation 3, Projects 4, and curation 5 across three files in 2.43 seconds. This is parent-run evidence, not independently executed by this reviewer.
- A broader unit run exercised many additional suites, including vault migration, mobile byte compatibility, MCP disconnect retirement, sync folding, redaction, and UI checks. It was stopped after sandbox-denied loopback/server fixtures and unavailable local Ollama calls produced timeouts. Those failures are environment-caused and do not contradict the targeted results, but this run cannot be reported as a full-suite pass.
- My initial HTTP attempt could not bind `127.0.0.1` in the sandbox (`listen EPERM`). The parent subsequently reran those exact cases with loopback permission while preserving all isolation constraints; the passing result is recorded above.

## Residual limits

The release control is procedural. It reduces the known transition risk only when users follow the full quit, reopen, tool-verification and read-only Resume sequence. The updater still does not detect or forcibly terminate every old MCP process, and an old process remains schema-compatible with the vault. This review also cannot prove packaged updater process termination, installed desktop/mobile UI behavior, live hosted sync, Vercel build/deploy behavior, or distributed multi-writer safety. A push of main will still trigger the existing GitHub-connected hosted deployments even though no hosted route is intentionally changed; production health and build success require the normal post-push checks. No production push was performed.


## Parent final regression verification

After the reviewer completed its control check, the parent reran the full unit regression suite from the same isolated checkout with loopback access, an empty environment, disposable HOME/NORTHKEEP_HOME and Keychain disabled. Result: 121 files passed; 1,578 tests passed and one skipped; 20.23 seconds. The parent also passed all 12 HTTP acceptance tests across three files. No product code changed in this final review pass. This does not certify a packaged installer, automatic old-process retirement or a future deployment.
