# ADR 0006 — Scope enforcement and the audit log

- **Date:** 2026-07-06
- **Status:** Accepted (M4)
- **Deciders:** Jay (compliance domain owner; approved the plan), Claude Code

## Context

M4 is "the professional demo": a practice must be able to guarantee that a
conversation about client A can never surface client B's matter, and prove it
to an auditor. The `scope` field has existed since v0.1; M4 makes it a
security boundary and adds the exportable audit trail.

## Decision 1: Grants come from configuration, never from the model

A scope grant is a capability handed to an MCP *connection*, not something the
AI can request — a model asking for its own access would defeat the control.
The grant is `NORTHKEEP_SCOPES` (comma-separated) on the server process;
**unset = full owner access** (the consumer default, since it's your vault).
To run a scoped connection — e.g. a lawyer working the Henderson matter — you
launch a Northkeep MCP entry with `NORTHKEEP_SCOPES=personal,client:henderson`.

## Decision 2: Enforcement is in the store, fail-closed

The allowlist is applied inside `Vault.list` (which `retrieve` builds on) as a
`scope IN (...)` clause — an empty allowlist returns nothing, and a caller
naming a scope outside its grant gets an empty result, never a leak. `forget`
checks the target entry's scope and reports "not found" for entries outside
the grant (doesn't even reveal they exist). `remember` refuses to write
outside the grant. Enforcing in the store, not the server, means every future
surface inherits it. The CLI runs as the owner (full access) by design.

## Decision 3: The audit log is the disclosure ledger, grown up

Every MCP call — success, denial, or error — appends a content-free row:
timestamp, **provider** (the MCP client's name, captured from its initialize
handshake), **granted_scopes**, **redaction_tier**, tool, params (counts, not
content), **denied**, result count, **disclosed_scopes**, and the disclosed
entry ids. `northkeep audit --format csv|json` (and a GUI export) render it for
an auditor. Still ids and scope labels only — never memory content.

## Decision 4: Opt-in Tier-1 masking of returned content

`NORTHKEEP_REDACT_TIER=1` makes a connection mask deterministic secrets
(Tier-1) in content *before* it leaves the vault toward the model, and the
audit records the tier. This is safe one-way (no restore needed). **Tier-2
pseudonymization is deliberately NOT applied over MCP**: retrieval has no
response hook to restore names, so the model would see and answer with
"Person-1". Full outbound pseudonymize/restore needs a provider proxy — the
parked deeper-integration decision. Tier-1 masking is the honest subset that
works today.

## Honest limits (KNOWN-LIMITS.md)

Scope isolation binds anything that goes *through* Northkeep's grant. It can't
stop the user from pasting client B's text into a client-A conversation
themselves, and it trusts the model provider's own retention controls once
redacted content is sent. Scope labels are chosen by whoever writes the
entry — mis-scoping at write time is a data-entry error the boundary can't
catch.

## Adversarial review (2026-07-06)

Reviewed with this milestone — maximally adversarial about scope-crossing.
Positive assurance (verified with probes): the `list()` allowlist SQL is
fail-closed and injection-safe (bound params, intersecting clauses);
`retrieve` can't score an out-of-grant candidate; `forget` enforces before
mutating and doesn't leak existence; `remember`'s default scope doesn't
bypass; Tier-1 masking is one-way and applied to both retrieve and list while
the disclosure ledger stays accurate; the audit is content-free and
token-gated. **No scope bypass and no content leak found.** Fixed from the
review: CSV formula-injection guard (a client-supplied provider like
`=cmd|...` is neutered before an auditor opens the export); `NORTHKEEP_SCOPES`
now fails CLOSED on a present-but-empty value (was silently granting full
access); provider name bounded/sanitized at capture; and `forget`'s id lookup
is scoped to the grant so out-of-grant rows can't affect the match count.
Documented (deliberate, not bypass): the owner GUI/CLI run with full access —
scope grants bind MCP connections.

## Dependencies introduced

None new to the tree: `@northkeep/mcp-server` now also depends on the existing
`@northkeep/redact` (for the opt-in Tier-1 masking). No new npm packages.
