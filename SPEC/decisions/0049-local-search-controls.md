# 0049: Explicit local-search controls

Status: implemented locally; owner approved the UI mock. Source review and automated checks passed; installed-app acceptance remains pending.

## Context

The Mac Memories search fallback tells users to start Ollama and download an embedding model through terminal commands. Existing local-model setup conflates a stopped runtime with an absent installation and adds every downloaded model as a chat endpoint. The owner requested an in-app start action.

## Decision

Expose a compact inline search status with an explicit start action for the installed Ollama Mac app. Keep keyword search available. After startup, check the embedding model separately; if absent, require a separate download click. Do not install Ollama, start a service automatically, add a dependency, or launch any model merely because a page loads.

A POST-only local startup route uses the existing loopback Host/session-token boundary and explicitly requires an unlocked vault, the desktop marker and macOS. It accepts no launch arguments. Invoke `/usr/bin/open` with fixed arguments identifying Ollama, using execFile without a shell. Bound subprocess execution and readiness polling; coalesce simultaneous attempts. Return server-owned error messages without subprocess output. Startup supports the installed Ollama app, not arbitrary service managers or executable paths supplied by a client.

Report runtime availability and configured embedding-model availability separately. Do not call an unreachable runtime an uninstalled runtime. A bare configured model name accepts exactly that name or its implicit :latest tag. An explicitly tagged name requires exact equality. Prefix matches do not establish readiness; the older helper is not used for this check.

An explicit embedding-model pull uses the existing Ollama loopback client and fixed configured embedding tag. It preserves the existing registry download boundary and sends no vault content. It is a separate user gesture from startup. Download jobs coalesce duplicate active requests and never evict an active job. Bound the actual pull using the existing one-hour client timeout and retain its single-flight key until it settles; expire only completed/failed records after retention. These jobs never register the embedding model as a chat endpoint. User-facing progress and errors use controlled text. Polling stops when the view/session is no longer active. A successful download retries the current search.

## Existing-view corrections

Project records remain stored and available through Projects. Memories requests opt into excluding project scopes before ranking and result limits; default API behavior stays intact for existing callers. Collection counts and navigation exclude project scopes. Search input immediately invalidates outstanding responses before its debounce delay. Project rows get explicit vertical spacing and a stable title size.

## Review and verification

Preimplementation assessment checked the boundaries against existing server auth, local-model routes/client and desktop environment handling. A separate final adversarial review checked actual code for command injection, missing token/unlock/platform gates, duplicate side effects, unbounded work, raw process/provider errors, automatic downloads and accidental chat-endpoint creation. Tests use disposable storage with mocked launch/network effects. No real runtime launch, model download or production vault mutation was performed by automated tests.

Owner UI mock: Previews/local-search-corrections.html (outside the source repo). Owner accepted this design before implementation of the new control.

## Review record

Read-only design assessment identified the existing fixed `/usr/bin/open` pattern and local pull machinery. Preimplementation review found implicit-tag matching and active-download retention ambiguities; both were clarified above. The existing auth/launch/client paths support the proposed design. Final independent review found one low-severity issue: completed download receipts had no count cap. The implementation now keeps at most 32 completed receipts while preserving active work; the regression test sends 40 requests and confirms eviction without downloads. The reviewer confirmed closure and returned CLEAN / PASS. Parent review also fixed post-probe lock races, synchronous client failure containment and duplicate-pull races. A read-only call to the real local Ollama service confirmed the nomic-embed-text:latest response shape used by the fixture. Visual browser verification remains unavailable because the browser plugin could not bootstrap; no screenshot or native launch acceptance is claimed.

## Addendum 2026-09-12: installed-app acceptance findings

The owner ran the d14fef5 build on the real vault with Ollama and nomic-embed-text present and reported that search did not work and that an "Install Ollama" link showed. Three causes, verified against code and a live server:

1. Every Memories search re-embedded every candidate. `session.withVault` opens the vault fresh per request, so the vault's disposable embedding table (ADR 0014, invariant 4) never survives between requests and is never persisted. Measured through the API on the owner's 859-memory vault: about 20 s per search, including repeats. The page showed nothing during that time, so it read as broken. Fix: `createCachedEmbedder` in `@northkeep/librarian`, a bounded (8192 entries) in-process LRU keyed by model plus the SHA-256 of the text, wrapped around the Ollama embedder once per web-server process. It touches no disk, no vault bytes and no network beyond the embedder's existing loopback call; `/api/lock` clears it because vectors derive from plaintext. Measured after the fix: first search 20.2 s, then 0.04 to 0.08 s. Warming the cache at unlock was considered and rejected for now because this ADR forbids loading a model merely because a page loads; the first search per launch still pays the full cost and the page now says so.
2. The status strip and its Install link rendered even when hidden. `.memory-search-status { display:flex }` and `.memory-search-status a { display:inline-block }` are author rules that beat the user-agent `[hidden] { display:none }`, the same trap already documented for `nav[hidden]` in this file's stylesheet. The vm-based UI tests set the `hidden` property and cannot see this. Fix: explicit `[hidden] { display:none }` rules for both elements.
3. The Install link used the browser default blue. The stylesheet had no `a` colour rule. Fix: `a { color: var(--accent) }`.

Also added: `loadMemories` shows a "Searching…" status as soon as a query is sent, unless a model download is in progress, so a slow first pass is visible rather than silent.

Review gate: this is ordinary work under the repo rule. No new egress path or recipient, no change to who decides, no new dependency, no crypto. Plaintext already went to the loopback embedder on every search; it now goes once per process instead of once per search. Tests: `packages/librarian/test/embedCache.test.ts` (copies, empty vectors, failure propagation, LRU eviction, model keying, clear); the two navigation tests that run `loadMemories` in isolation now stub the status helper. One pre-existing failure in `apps/web/test/api.test.ts` ("review report is locked before checking report existence", expects 423 and gets 500) fails identically with these changes stashed and is not addressed here.
