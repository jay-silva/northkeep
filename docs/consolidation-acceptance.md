# Guided consolidation acceptance

This runs an isolated sample vault and a deterministic local model stub. It never opens your real vault or contacts a cloud model. The stub exercises the interface, not model quality.

## Start the sample

Run in Terminal with the existing dependencies:

```sh
cd /Users/jsilva/Claude/Projects/NorthKeep/northkeep
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/librarian/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json
cp apps/web/static/index.html apps/web/dist/static/index.html
env -i PATH="$PATH" TMPDIR=/private/tmp NORTHKEEP_NO_KEYCHAIN=1 node scripts/consolidation-preview.mjs
```

Open the printed local URL and unlock using `synthetic-preview-only`. These sample credentials protect only the newly generated fixture. Stop the sample with Control-C when finished.

## Check the workflow

1. Open Review in the main sidebar. Select writing. The project document must not be included. The instruction box should guide suggestions without being a general chat transcript.
2. Find suggestions. Inspect the vertical queue, full Source memories, and editable Proposed memory. The technical-review exception should remain intact. Explanation must be separate from the text that will be saved.
3. Edit the proposed wording, then preview. Verify all three originals and the exact replacement are visible. Cancel or Escape changes no memory; Escape returns focus. Reopen preview and confirm once.
4. Browse Memories. The replacement should be active; original wording should remain available through consolidation history. Inspect Change history and restore the originals. This creates new copies, not a vault rollback.
5. Confirm Memories includes a collection list and all existing memory actions. Connect starts collapsed; clicking it reveals Desktop and Cloud. Settings remains accessible, including model configuration. Legacy chat is no longer a destination. Existing stored memories and provenance remain available.
6. Repeat at a narrow 390px window and in light/dark appearance. Selected names, sources, editor and confirmation controls must remain readable. The suggestions queue should be reachable with a back control.

To test source removal, restart the sample. Exclude a source from a proposed group and check that the old wording cannot be silently applied as an unchanged draft. Keep separate should change no memory.

## Real local-model evaluation

After building, this separate probe uses your already installed local Ollama models against newly generated synthetic memories:

```sh
env -i PATH="$PATH" TMPDIR=/private/tmp NORTHKEEP_NO_KEYCHAIN=1 node scripts/consolidation-evaluate.mjs
```

Inspect the output for preserved exceptions and numeric distinctions. No automatically generated proposal is guaranteed correct. A small probe is not a general quality benchmark.

## What this does not accept

Acceptance is for this local consolidation milestone, not a deployment, vault-format change, removal of legacy history, cross-collection/shared consolidation, or project coordination. Old-reader compatibility and the synthetic test results are recorded separately in ADR 0047 once verified.
