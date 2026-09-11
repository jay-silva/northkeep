# Mac Memories and Projects correction pass

The owner approved the inline local-search design after reporting three issues in the installed 0.22.0 Mac app.

## Implemented locally

- Memories offers an explicit Start local search action when Ollama is unavailable, and a separate Download search model action when its embedding model is absent. Starting does not download anything. Model downloads do not become chat endpoints.
- The project list has explicit title/summary/badge spacing, readable title sizing and constrained wrapping.
- Project scopes are omitted from Memories collections, counts and results. Filtering precedes ranking and limits, so many project hits cannot crowd out ordinary memories. Projects remains the home for their records; nothing is deleted or moved.
- Typing immediately invalidates old results and local-search status. An old one-letter query could previously show an empty-query warning under a newly typed word such as dog.

The installed runtime was checked read-only: Ollama was running and nomic-embed-text:latest was installed. No real model was started or downloaded for testing.

## Verification

The web suite passed 154 tests before the final receipt-cap regression was added. The final local-search helper suite passed 11 tests, including that regression. TypeScript compilation passed. Fifteen authenticated HTTP checks passed across local search, memory filtering, Projects, curation and consolidation. New coverage includes missing token/locked vault, exact model tags, explicit start versus pull, duplicate requests, delayed status and lock races, sanitized errors, synchronous client failures and project filtering before the search limit.

Independent source review returned CLEAN / PASS after the completed-job retention finding was addressed. See ADR0049 for the exact gates and review record.

The browser plugin failed to bootstrap because its worker referenced a missing service module. The layout has source and behavioral checks, but no live desktop/390px screenshot verification in this pass. The layout detector also reported degraded parser support; its empty findings list is not visual proof.

## Owner acceptance on the rebuilt Mac app

1. Fully quit NorthKeep and connected local AI hosts before replacing the app, then reopen.
2. In Memories, verify project collections are absent, ordinary counts agree, and the same records remain under Projects.
3. Type quickly, including d then dog. Results and the local-search message must correspond to the final query, with no stale empty-query warning.
4. In Projects, inspect short and long titles: title, summary and badge have separate vertical spacing; no overflow at a narrow window width.
5. When Ollama is stopped, search and click Start local search. Confirm it starts and reruns the search. If the embedding model is missing, download it only through the separate button. Do not remove an installed model merely for this check; use a disposable environment for the missing-model case.
6. Check the same flow with keyboard navigation and a 390px-wide window. Locking or leaving Memories must stop UI polling and prevent late results from appearing.

These changes are local source work until a new Mac artifact is built and installed. No paid build, submission, source push or release publication is part of this correction pass.
