# ADR 0035: Remote MCP servers over HTTPS, with OAuth

Status: Accepted and implemented 2026-07-25 (M12); invariant #7 OK from Jay ("Build 0035") · Review: rewritten after a 2026-07-25 adversarial review; second pass 2026-07-27, five findings fixed with tests. Acceptance passed 2026-07-27 with four findings.

## Context
iOS cannot spawn stdio servers; official servers use HTTP and OAuth. Remote MCP inherits the definition pin, result fence, body-leaf screens and audit, but no egress protection automatically.

## Decision
- D1: Streamable HTTP over `https` only. `remoteUrlRefusal` refuses http, bare IPs, `localhost`, `.local`, `.internal`, URL credentials, and non-`bounded` classification; syntactic only. `guardedFetch` resolves at every connect, refuses if any answer is private, and dials the pinned address, for MCP and OAuth discovery alike; only ports 443/8443 work.
- D2: Identity is the exact origin. A changed origin refuses the connection, like `McpFingerprintChangedError` for stdio.
- D3: `trust: 'trusted'` is not offered, so the Tier-1 argument floor stays on. Prompt and proof show the origin. Jay: a `private-only` conversation refuses remote MCP tools before the gate (fail closed if its server is unresolvable); web tools still ask under the pin.
- D4: Argument redaction is the Tier-1 floor only; a future Tier 2/3 must refuse if NER is unavailable.
- D5: A remote server contributes nothing, not even a tool list, until a completed OAuth token is in the Keychain; connecting requires the passphrase. A server must demand auth: refuse the anonymous handshake or publish RFC 9728 metadata naming an authorization server (amendment, Jay 2026-07-27); otherwise refused. This stops credential-less endpoints only; a hostile server could always pass by answering 401. A cross-origin authorization server is shown and needs a click before the browser opens.
- D6: Tokens live in the Keychain, never `mcp.json`. One listener binds 127.0.0.1:8788 only during a connect, is bound before the browser opens, answers once, and checks a random `state`. A pasted client id and secret are saved only once their grant succeeds.

## Consequences
- Limits: no zero-config path. Refresh writes serialize within a process, not between CLI and GUI. Keychain is macOS-only. The proof's endpoint is constant; it proves what was sent only if it carries the redacted arguments. Arguments reach the server in plaintext after Tier 1. Results also reach the answering model. Removing a server does not revoke at the provider; provider revocation lands at token expiry. No spend or call cap. Tracked at acceptance: Google issues no refresh token without `access_type=offline`; scope selection requests every advertised scope; the GUI cannot mark tools read-only.

## Rejected
- "OAuth sign-in is the gate": servers can list tools unauthenticated and choose the authorization server.

## What leaves the machine
A new recipient, recorded as a real widening of invariant #1 via clause (c), approved by Jay 2026-07-25: tool-call arguments, after the Tier-1 floor, to a remote server the user connected, only for allowed calls; never the vault or conversation. OAuth traffic goes to the provider via `guardedFetch`.

## Links
Parent: ADR 0033, ADR 0034 · Full record: docs/design/adr-0035-remote-mcp-servers.md
