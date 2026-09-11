# Projects handoff design

Status: owner approved the clickable design on 2026-09-10 ("Approved"). Implemented locally under ADR 0048; owner application accepted. M1/M2 were accepted and committed locally in 6bc3b8b. Nothing has been pushed or deployed.

## Experience

Projects extends the approved Memories layout and palette. A project opens to its current summary, next actions, decisions and open questions, files, and secondary session history. Resume shows a read-only brief. Checkpoint reviews progress before continuing; Wrap up reviews the state another assistant will inherit. A newer update blocks an older draft and preserves the draft for comparison. Unavailable files remain visible and are never represented as inspected evidence.

The approved design artifact is `projects-handoff-preview.html`. Its receipts are simulated. The implemented application sample is launched with `scripts/projects-preview.mjs` and uses a disposable vault.

## Implemented contract

ADR 0048 records the pre-implementation adversarial review and binding decisions. Local project writes require the exact read revision. Checkpoint and wrap save the document, rolled logs and a durable retry receipt together. Duplicate live heads and changed operation reuse refuse. Files are descriptive references; no path is opened or URL fetched. Lock clears draft text. Existing opted-in sync behavior remains, but a local receipt does not certify delivery.

The Codex to Claude Desktop checkpoint/resume/wrap test passed through a disposable local MCP client. Hosted coordination and installed-client configuration were outside this milestone. Verification, evidence and remaining owner acceptance are in `projects-acceptance.md`.
