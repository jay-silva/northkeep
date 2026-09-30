# ADR 0063: Sync guardrails: cloud project writes fast-forward only, destructive syncs preview first

Status: Proposed · Review: pending (findings go in docs/design/sync-guardrails.md)

## Context
On 2026-09-30 one Sync now rolled five projects back 7 to 9 days. Down-sync writes every pending cloud document over the local head without checking which is newer (`connector-client.ts:366-374`). The connector serves pending rows ahead of newer pushes (`mcp.ts:104-118`), and it received pushes only by hand. A diverged `sync pull` replaces the vault without saying what drops out. A cloud write never records which document it started from.

## Decision
- D1: Down-sync applies a cloud document only as a fast-forward. The row's `base_revision` must equal the local head's revision; anything else is held as a conflict the user resolves (view both, take theirs, keep mine). It never replaces the head automatically.
- D2: The connector orders rows by base, not by time or pending state. Every write gets a new revision, and a stale `expected_revision` is refused.
- D3: Sync now shows a preview and asks for confirmation before any replace or forget. It applies only rows the user approved. The CLI takes `--yes`.
- D4: A "Restore this version" action writes an old revision back as a new head, refusing on a stale head.
- D5: Shared scopes push automatically after a local write, over push by hand only. Push only, debounced, on by default with a switch.
- D6: A manual pull reports what would drop out and asks before it replaces anything. Merge stays out of scope.

## Consequences
- Easier: a cloud write can no longer roll a project back silently. Recovery takes one click.
- Harder: the user now resolves conflicts. Three new screens need approved mocks. Connector clients from before this ADR stop receiving cloud project updates.
- Committed to: one `base_revision` column, a `?v=2` pending protocol, the connector deploying before the clients, and storage tests on real Postgres.

## Rejected
- Newest timestamp wins: the in-memory and Neon stores stamp `created_at` differently, and a timestamp says nothing about the base.
- Server-side conflict detection only: the connector cannot see unpushed local saves, which is how the incident happened.
- Automatic merge of documents or vaults: it is guesswork on the one path that just lost data.

## What leaves the machine
The content does not change: shared scopes only, to the same connector. D5 changes when it leaves, within seconds of a write instead of on a click. The connector also sees the edit cadence more finely and a base entry id per cloud write.

## Links
Design: docs/design/sync-guardrails.md · Plan: NorthKeep project northkeep · Extends: ADR 0044 (the connector was out of scope), ADR 0050 (held rows), ADR 0051 (restore limit)
