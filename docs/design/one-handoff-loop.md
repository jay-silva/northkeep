# One handoff loop: design notes for ADR 0068

Proposed, not built. Line numbers are at branch claude/review-u6-handoff-loop.

## D1: the shared package
Moves in: `project-doc.ts` and `project-milestones.ts` (copied today at apps/connector-server/src/, tested byte-identical at test/m14-projects.test.ts:31 and test/adr0065-milestones.test.ts:80), plus the pure half of `packages/core/src/project-handoff.ts`: section ownership (:38), the checkpoint merge (:283-289) and ledger record parsing (:314-320). Hashing is injected; the package imports nothing.

The deploy question. Vercel runs `src/index.ts` itself (`buildCommand: "true"`, vercel.json:3) and loads it as CommonJS; a live ESM import of a workspace package returned 500 before (adr-0040 design :150-160). Untried: a package shipping a CommonJS build. Check before merge, on a Vercel preview with a throwaway account: `project_get` and `project_update` succeed with no module error logged. If not, `pnpm build` writes `apps/connector-server/src/generated/project-rules/` from the package with a "generated, do not edit" header, and a test fails when it is stale. Vercel then sees today's layout.

## D2: hosted resume, checkpoint, wrap
Same arguments as local (server.ts:1186-1201) except `milestone_passed`, refused because no hosted write may add a pass (mcp.ts:1043). `vault_id` is an opaque per-account id, not the account hash, so no stored key is shown to apps. `open_sessions` and `mirror_status` come from local logs and are absent from hosted resume.

Ledger table: `connector_operations(account_hash, scope, operation_id, fingerprint, result_revision, saved_at)`. `fingerprint` is an HMAC, under a key derived from the account's data key, of the same logical request local hashes (packages/core/src/vault.ts:958-967), so the database cannot test guesses at content. Rules follow ADR 0062 D4: same id and fingerprint returns the original receipt; a different fingerprint is `operation_conflict`. The table is cut to 16 rows per scope at each save and deleted with the scope on unshare.

## D3: the contract sentence
Today: "a random version-4 UUID, in lowercase, that you generate as operation_id" (project-recipe.ts:20). After: "the next_operation_id from the latest resume or save result". Issued ids are random and not remembered: a derived id would give two agents resuming one head the same id.

## D4: JSON results
`project_get`, `project_create` and `project_update` return JSON text matching local's fields; `structuredContent` (mcp.ts:805, 927, 1096) stays.

## D5: How to Work Here
Four labelled lines: Repo, Branch, Test, Dangers. Egress mitigations: the tool text asks for a path relative to home (`~/code/x`), says never to put credentials or hostnames that are not public, and resume marks the section "reported by the writing machine; check it here", as it already does for files (server.ts:220-232).

## D6: the per-host check
One page in docs/, one line per host: resume, checkpoint, resend the same checkpoint (expect the original receipt), wrap, resume on the next host (expect the wrap). Local hosts can reuse the stdio end-to-end tests; Claude.ai and ChatGPT need a person and a throwaway account.

## Open questions for Jay
1. Is one release long enough to accept client UUIDs?
2. Should a hosted wrap be allowed to record an agent pass, as local does?
3. Who runs the two web hosts before each release?
