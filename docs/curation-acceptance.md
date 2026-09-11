# Curation milestone 1: acceptance

This milestone improves memory review. The owner accepted it locally on 2026-09-10. Project resume/checkpoint/wrap and concurrent-agent coordination remain later milestones. Nothing here deploys NorthKeep or changes your real vault.

## Try it with synthetic memories

Run these commands in Terminal from the repository root. They compile the changed packages with the already installed TypeScript compiler; they do not install dependencies or contact a model provider.

```sh
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/librarian/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json
cp apps/web/static/index.html apps/web/dist/static/index.html
env -i PATH="$PATH" TMPDIR=/private/tmp NORTHKEEP_NO_KEYCHAIN=1 node scripts/curation-preview.mjs
```

The last command creates a new temporary vault and prints its local URL. Open that URL and unlock with `synthetic-preview-only`. These credentials protect only the generated sample data. Leave “Keep unlocked” unchecked. Stop the preview with Control-C when finished.

1. Open **Change collection**. Planning and writing should appear with counts; the sample project document must be excluded. Choose writing. The collection controls must not claim a model is installed before checking it.
2. Reload to return to the pre-seeded review. Inspect the original evidence. Edit the suggested wording, preview it, then save. The active memory must contain exactly the previewed text.
3. Open **Change history**. Inspect before/after, preview restoration, then restore. The original wording returns as a new revision, not a rollback of the vault.
4. Inspect **Choose what stays**. Select a retained original and preview one removal. Remove only that repeated entry; another must stay active. Restore the removal from history if desired. A stale proposal may be refused after step 2 changed one of its sources; that is intentional. Restart the fixture for an independent duplicate scenario.
5. Inspect the workshop question. Either write an exact answer and choose the cited memory to update, or leave it unresolved. Leaving unresolved must change no memory and must not permanently suppress that question in future passes.
6. Search for “workshop.” Browsing/search should remain usable alongside review. Try a narrow window: sources, editor, previews, Export, and Lock must remain usable.

The seeded queue deliberately says **Incomplete**. Its suggestions are hand-authored test data, not a claim of model accuracy. To exercise a real local review, select a collection and start review with your existing Ollama models; missing models should produce a visible error, never a cloud fallback. Do not choose the optional cloud path for this acceptance test.

## Verification commands

From the repository directory after building:

```sh
env -i PATH="$PATH" TMPDIR=/private/tmp NORTHKEEP_NO_KEYCHAIN=1 node node_modules/vitest/vitest.mjs run
env -i PATH="$PATH" TMPDIR=/private/tmp NORTHKEEP_NO_KEYCHAIN=1 node node_modules/vitest/vitest.mjs run --config e2e/vitest.config.ts e2e/curation.test.ts
env -i PATH="$PATH" TMPDIR=/private/tmp NORTHKEEP_NO_KEYCHAIN=1 node scripts/curation-evaluate.mjs
```

The last command uses only newly created synthetic memories and your local Ollama. It never reads an existing vault and asserts that review does not change its generated vault. A passing small probe does not establish general accuracy.

## Limits worth testing with your judgment

- A model can miss an issue or suggest an incorrect resolution; source quotes are evidence, not proof.
- Review receipts retain plaintext source snapshots locally with private file permissions. They do not sync or travel in vault exports, and can retain text removed from the vault.
- Restore refuses if the recorded result changed elsewhere. It never rolls back unrelated work.
- No automatic acceptance, bulk deletion, cross-collection merge, or new sharing is introduced.

Tell the lead which step passed or failed. The owner accepted this local milestone on 2026-09-10; release and deployment remain separate from automated verification and acceptance.
