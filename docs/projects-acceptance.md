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

On 2026-09-11, a fresh Codex conversation exposed all three new handoff tools and successfully read NorthKeep through project_resume, returning its current revision and structured handoff sections. This verifies installed Codex discovery and Resume. Claude Desktop opened successfully, but inspecting its connector menu failed with the same ScreenCaptureKit capture error. Claude tool-name verification and installed-client write verification remain incomplete. No live-vault test writes or configuration changes were performed. Rules version: 2026-09-07.1.
