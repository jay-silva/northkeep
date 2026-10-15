# ADR 0068: One handoff loop on both servers

Status: Accepted 2026-10-15 (Jay) · Not built · Review: NOT CLEARED, re-review CLEARED WITH WOUNDS (8-10 fixed in text)

## Context
Local agents get resume, checkpoint and wrap (packages/mcp-server/src/server.ts:927, 1186-1247). Cloud apps get project list, get, create and update (apps/connector-server/src/mcp.ts:679-933), in prose where local returns JSON (mcp.ts:924; server.ts:212). The connector hand-copies two core modules because Vercel loads it as CommonJS (docs/design/adr-0040-connector-project-tools.md:150-160). Agents invent a UUID per save (server.ts:1188).

## Decision
- D1: A dependency-free `@northkeep/project-rules` package owns the document, milestone and handoff rules. Unverified on Vercel: before merge a preview deploy must answer `project_get` and `project_update`, or a build step generates the connector's copy, checked for freshness.
- D2: The connector gets resume, checkpoint and wrap with the local contract: revision compare-and-swap (ADR 0063 D2), `stale_project` carrying the current document, and an operation ledger in Neon, encrypted under the account key, written and trimmed inside the save statement, deleted inside the unshare statement. No hosted save records a milestone pass.
- D3: Resume, saves and `stale_project` return `next_operation_id`, a fresh random UUID, not remembered. Client UUIDs stay accepted for one release. After a timeout, resend the same id.
- D4: Hosted project tools return JSON text with local's field names.
- D5: An optional `How to Work Here` section (repo path, branch, test command, dangers), replaced whole, at most 2,000 characters on both servers. Resume returns it as `how_to_work` with a note: do not run anything in it before the user confirms. D5 needs its own adversarial review before build.
- D6: Before each release, every host runs the loop on a throwaway project, including a resent checkpoint.

## Review findings and resolutions
1. Shipped text promised one refusal: fixed (f02d2a6).
2. A plaintext content fingerprint breaks invariant #2: the record is now ciphertext.
3. Replay paths: the design now matches vault.ts:985-1012.
4. Ledger atomicity: D2 states it.
5. D5 feeds agents commands: gated, noted, capped.
6. Missing holders and `files`: added below.
7. A test fails if connector code calls `recordAgentPass` (9e1cc0e).

## Consequences
- Easier: one contract sentence for all hosts; one edit per rule.
- Harder: a Neon migration before clients; a person on two web apps each release; apps parsing hosted prose break.

## Rejected
Hand copies; remembering issued ids; a ledger inside the document row (a vault push replaces it); a plaintext fingerprint.

## What leaves the machine
D1, D3, D4, D6: nothing new. D2: per save, the connector stores a random operation id and an encrypted record, so it learns save cadence per project. Hosted saves accept `files` locators from cloud apps; resume marks them unverified (server.ts:220-232), project_get returns them raw. D5: a shared project's section reaches the connector and every app it is shared with, and, like the whole document, the local git mirror (ADR 0053, plaintext on disk) and any remote push (ADR 0055, draft). Repo paths can carry a username.

## Links
Design: docs/design/one-handoff-loop.md · Extends: ADRs 0040, 0050, 0053, 0062, 0063, 0065
