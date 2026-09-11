# Projects acceptance

Status: implemented locally after approval of the Projects mock. Owner accepted the application: “looks good.” Nothing has been pushed or deployed.

## Open a disposable sample

From the repository, after the local build is current:

```sh
env -i PATH="$PATH" TMPDIR=/private/tmp NORTHKEEP_NO_KEYCHAIN=1 node scripts/projects-preview.mjs
```

Open the printed loopback address and unlock with `synthetic-preview-only`. This launcher creates its own vault and configuration directory before importing the application. It never reads the owner's configured vault. Stop with Control-C. Existing connections must not be enabled in this sample.

## Check the approved workflow

1. Open Projects. Switch between Field Notes and Trail Journal. Current summary, next actions, decisions, questions, files and history should be readable. The layout should match the approved mock.
2. Resume Field Notes. The missing audio index must remain unavailable or unverified for the receiving assistant, never presented as checked evidence. Close the brief with Escape; focus returns to Resume.
3. Checkpoint. Edit status and completed work; leave next actions empty if desired. Review the exact text. Back to edit must retain every field. Save once. The receipt must say saved on this device, and the new state must survive lock/unlock.
4. Wrap up. Record completed work and the next action, review and save. Inspect the current log, saved versions and older log entries. These are separate history views with bounded results.
5. At 390px, project selection becomes a native select and the actions fit without horizontal overflow. Check dark and light appearance.

The parent additionally exercised a competing-client save while an older browser draft was open. The older save returned a conflict, preserved the complete draft beside the newer state, and did not overwrite the newer work. HTTP and core tests repeat this with disk-byte checks.

## Actual assistant handoff

The selected Codex to Claude Desktop test ran against a session-created vault through `scripts/projects-handoff-client.mjs`. Codex created a checkpoint; Claude Desktop used its local terminal tools to invoke `project_resume`, interpreted the missing-file limitation, authored a JSON wrap request and invoked `project_wrap`. Parent readback verified the new status, next action, unavailable file and result revision. The observed synthetic response is in `evidence/projects-claude-desktop-handoff.json`.

This is a real two-assistant test through a disposable MCP client, not a test of newly installed connector configuration. No assistant configuration or real vault was changed. Claude's chat display remained stale; automatic review refused a refresh while it showed streaming/queued state. The evidence is the successful local MCP call log and persisted wrap readback, not a claimed final chat screenshot.

## Boundaries

Every new HTTP route inherits the existing session-token gate and requires an unlocked vault. MCP retains grants. New handoff writes require the exact read revision and a unique operation ID; retries with the same request recover their durable receipt. Changes to the same operation refuse. Shared scopes retain existing opted-in sync behavior; a local receipt does not certify remote delivery.

Files remain descriptive references. The UI preserves existing references; adding or revising them is available through the structured project tools. No path is opened or URL fetched. Hosted/distributed write coordination remains separate work. Drafts and pending request text are cleared on lock for privacy; browser retry convenience lasts only while its draft state is retained. Durable saved versions and MCP operation receipts remain in the vault.

The sample must not be used to claim installed-client upgrade, hosted sync or packaged mobile certification. Automatic OS theme switching remains unverified; the appearance check uses a disposable copy forcing the existing light CSS.

## Final local verification

Authoritative rules version: 2026-09-07.1. Final isolated build passed for core, web and MCP. The regression suite passed 1,578 tests with one skipped across 121 files. Projects HTTP acceptance passed four tests; curation and consolidation HTTP regression passed eight, for 12 HTTP checks total. Dark and forced-light desktop and 390px layouts were inspected in Silva Peak Chrome without horizontal overflow. The owner checkout contains the current compiled output. Owner application acceptance completed: “looks good.”

## Installed-client readiness

After owner acceptance, read-only inspection confirmed that Codex and Claude Desktop already point to the owner's compiled local MCP entrypoint. No configuration edit is needed. Core and MCP JavaScript output matched the isolated build byte for byte. A fresh stdio process with an empty disposable home and Keychain disabled advertised project_resume, project_checkpoint and project_wrap; project_update requires expected_revision.

On 2026-09-11, a fresh Codex conversation exposed all three new handoff tools and successfully read NorthKeep through project_resume, returning its current revision and structured handoff sections. Claude subsequently reported native discovery and successful Resume through its existing local connection, closing the earlier screen-capture blocker.

The owner then said "approved" to adding a separate northkeep-acceptance connection in Claude Desktop. Only that entry was added, with a private configuration backup and preservation checks. It launches the existing server with a clean environment, a session-created synthetic vault, Keychain access disabled, a single project scope and no sync configuration. Existing connections were preserved.

The owner relayed successful native Claude Resume, Checkpoint, identical Checkpoint retry, fresh Resume, Wrap and final Resume. The retry returned replayed: true with the original result revision and timestamp. An independent readback confirmed final revision 56b75e60-2878-4d6e-b5f5-7d62d00040ac, the exact final status and next action, preserved open question, unavailable file reference, and one checkpoint followed by one wrap in saved history. The retry behavior is reported native-client evidence; persisted final state and history were independently checked.

This closes native Claude local-write acceptance. Codex native discovery/Resume and the earlier disposable two-assistant handoff are separately verified. Stale-write refusal with unchanged vault bytes passed the exact-launch preflight; the native Claude sequence was uncontested and does not itself prove concurrency behavior. No hosted sync, distributed coordination or packaged mobile certification is claimed. Claude also reports the legacy hosted connector alongside the local connection; its project_update lacks revision binding. After the owner separately approved removal, only the temporary acceptance connection was removed from Claude Desktop configuration; preservation checks confirmed all other configuration values and test files remained intact. An already-running client may retain the tools until its next restart. No test data was written to the real vault. Rules version: 2026-09-07.1.

The final upgrade review found that a pre-update local server can keep the old project writer alive because the vault schema is unchanged. The release therefore requires full client shutdown before installation and fresh tool discovery afterward, as detailed in `update-memory-projects.md`. Acceptance of the current local process does not certify automatic termination of older processes.
