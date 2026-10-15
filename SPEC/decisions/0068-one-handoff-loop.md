# ADR 0068: One handoff loop on both servers

Status: Proposed 2026-10-15, awaiting Jay and adversarial review · Not built

## Context
Local agents get `project_resume`, `project_checkpoint` and `project_wrap` with an operation id and a revision check (packages/mcp-server/src/server.ts:927, 1186-1247). Cloud apps, through the connector, get only project list, get, create and update (apps/connector-server/src/mcp.ts:679, 739, 817, 933), in prose where local returns JSON (mcp.ts:924; server.ts:212). The connector hand-copies two core modules because Vercel loads it as CommonJS and a workspace ESM import crashed it (docs/design/adr-0040-connector-project-tools.md:150-160). Agents must invent a UUID per save (server.ts:1188). Resume says where work stands, not how to work safely.

## Decision
- D1: A dependency-free `@northkeep/project-rules` package owns the document, milestone and handoff rules; core re-exports it and the connector imports it. Whether Vercel loads it is unverified: before merge, a preview deploy must answer `project_get` and `project_update`. If it cannot, a build step generates the connector's copy from the package, checked by a freshness test.
- D2: The connector gets resume, checkpoint and wrap with the local contract: `expected_revision` compare-and-swap (ADR 0063 D2), `stale_project` carrying the current document (mcp.ts:662-676), and an `operation_id` ledger in a new Neon table, last 16 per project, deleted on unshare. No hosted save adds a milestone pass (ADR 0065).
- D3: Resume, every save and every `stale_project` return `next_operation_id`, a fresh random UUID the server does not remember. Client UUIDs stay accepted for one release. After a timeout, resend the same id.
- D4: Hosted project tools return JSON text with local's field names.
- D5: An optional `How to Work Here` section (repo path, branch, test command, dangers), replaced whole, at most 2,000 characters, returned by resume as `how_to_work`.
- D6: Before each release, every host runs resume, checkpoint, a resent checkpoint, wrap, and resume elsewhere, on a throwaway project, recorded in the release evidence.

## Consequences
- Easier: one contract sentence for every host; one edit per rule; "Sync + Handoff" becomes true for cloud apps.
- Harder: a Neon migration shipped before clients; a release step needs a person on two web apps.
- An app that parsed hosted prose breaks.

## Rejected
- Keeping hand copies: two edits per rule.
- Remembering issued ids: state for no gain.
- Ledger inside the encrypted row: a vault push replaces the row and forgets it.

## What leaves the machine
D1, D3, D4, D6: nothing new. D2: per save, the connector stores the operation id, a fingerprint keyed under the account key, the result revision and the time. That adds save cadence per project; slugs are already readable there. D5: a shared project's section reaches the connector, encrypted at rest, and every app it is shared with. A repo path can carry a username; dangers can name infrastructure. Mitigations are in the design.

## Links
Design: docs/design/one-handoff-loop.md · Extends: ADRs 0040, 0050, 0062, 0063, 0065
