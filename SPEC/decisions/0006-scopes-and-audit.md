# ADR 0006: Scope enforcement and the audit log

Status: Accepted 2026-07-06 (M4) · Review: adversarial review 2026-07-06 found no scope bypass and no content leak; fixes listed below

## Context
M4 is the professional demo: a practice must be able to guarantee that a conversation about client A can never surface client B's matter, and prove it to an auditor. The `scope` field has existed since v0.1; M4 makes it a security boundary and adds an exportable audit trail.

## Decision
- D1: Grants come from configuration, never from the model. The grant is `NORTHKEEP_SCOPES` (comma-separated) on the MCP server process. Unset means full owner access; a present-but-empty value fails closed.
- D2: Enforcement is in the store and fails closed. `Vault.list` (which `retrieve` builds on) applies a `scope IN (...)` clause; an empty allowlist returns nothing and an out-of-grant scope returns an empty result. `forget` reports "not found" for entries outside the grant and scopes its id lookup to the grant. `remember` refuses to write outside the grant. The CLI and owner GUI run with full access by design.
- D3: Every MCP call (success, denial or error) appends a content-free audit row: timestamp, provider (the client's name from its initialize handshake, bounded and sanitized), granted_scopes, redaction_tier, tool, params (counts, not content), denied, result count, disclosed_scopes and disclosed entry ids. `northkeep audit --format csv|json` and a GUI export render it; the CSV export guards against formula injection.
- D4: `NORTHKEEP_REDACT_TIER=1` opts a connection into Tier-1 masking of returned content before it leaves the vault toward the model, on both retrieve and list. Tier-2 pseudonymization is deliberately not applied over MCP: retrieval has no response hook to restore names.

## Consequences
- Easier: every future surface inherits scope enforcement from the store; an auditor gets a content-free ledger of what was disclosed.
- Harder: running a scoped connection means launching a separate MCP entry, e.g. `NORTHKEEP_SCOPES=personal,client:henderson`.
- Limits: scope isolation binds only what goes through NorthKeep's grant. It cannot stop the user pasting client B's text into a client-A conversation, it trusts the model provider's retention controls once redacted content is sent, and mis-scoping at write time is a data-entry error the boundary cannot catch. Owner GUI/CLI are not scope-bound.

## Rejected
- Letting the model request its own scopes: a model asking for its own access defeats the control.
- Enforcing in the server instead of the store: later surfaces would not inherit it.
- Tier-2 pseudonymization over MCP: the model would see and answer with "Person-1"; full pseudonymize/restore needs a provider proxy (parked).

## What leaves the machine
The original names no new egress path. Content a granted MCP connection retrieves goes toward its model as before, Tier-1 masked when the connection sets `NORTHKEEP_REDACT_TIER=1`; after that NorthKeep relies on the provider's own retention controls. The audit log holds ids and scope labels only, never memory content. No new npm packages.

## Links
Full record: docs/design/adr-0006-scopes-and-audit.md
