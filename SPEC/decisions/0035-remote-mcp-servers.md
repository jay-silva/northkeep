# ADR 0035: Remote MCP servers over HTTPS, with OAuth

- **Date:** 2026-07-25
- **Status:** Proposed
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0033 (MCP client trust model), ADR 0034 (adding servers from the GUI)

## Context

M11 shipped stdio only. That was the right first cut — the vault's own server is
a local process, and stdio let us build the trust model against something we
fully control. But three things now argue for remote servers, and the strongest
is not the one that prompted the question.

**Tools on the phone are otherwise impossible.** iOS forbids spawning child
processes, so stdio MCP can never run there. When mobile scope was discussed the
conclusion was that tools would need a Mac relay: the phone asks a paired,
awake Mac to run the tool loop. Remote MCP is a second path and a far cheaper
one — the phone speaks HTTPS to the server directly. No Mac awake, no LAN
pairing, and no new listening surface on the desktop, which is the part of the
relay design that would have needed its own security review. This alone
justifies the milestone.

**The official servers are remote.** Google's Gmail MCP server is HTTP with
OAuth at `https://gmailmcp.googleapis.com/mcp/v1`. Stdio-only means a NorthKeep
user reaches for a community package and hands it their own Google Cloud OAuth
credentials, instead of using the first-party server with a scoped token they
can revoke from their Google account. For a product whose pitch is careful
handling of your data, pushing people toward third-party forks because we cannot
speak the official protocol is backwards.

**And it reuses more machinery than stdio did.** This is the surprise. A remote
MCP server is architecturally the same shape as a bounded model endpoint: a
named HTTPS host we send content to. Stdio was the awkward case — it forced
`egress()` to return null, forced server identity to travel structurally because
there was no URL to classify, and limited the argument floor to deterministic
Tier 1 because we could not see the destination. With a remote server we know
exactly where the arguments go, so host classification, the full redaction tier,
the privacy ceiling, the exfiltration screens' URL decomposition, per-host
grants and the egress proof all apply as they already do for `web_fetch`.

## Decision 1: HTTPS streamable HTTP only

The transport is the MCP streamable HTTP transport over **https**, and nothing
else. Not SSE (legacy), not WebSocket, and **not plain http, including
loopback**.

Refusing loopback http is deliberate. ADR 0033 already notes that a loopback
origin is only a port number, which any local process can claim after a restart,
so it earns no trust beyond "some program on this machine". A local server
should be configured as **stdio**, where the launch fingerprint gives real
identity. Allowing loopback http would offer a weaker identity for the same
capability.

## Decision 2: identity is the TLS-authenticated origin

A launch fingerprint is meaningless here — there is no command, no argv, no cwd.
Identity becomes the **exact origin** (scheme, host, port), matched exactly, with
no wildcards and no subdomain inheritance, inheriting policy.ts's rule verbatim
and for the same reason: `api.example.com` may be a different team, a different
vendor, or an attacker on a dangling CNAME.

What authenticates that origin is TLS. This is genuinely *stronger* than the
stdio fingerprint, which ADR 0033 admits detects configuration changes rather
than program changes: a certificate binds the name to a party, where a path
binds nothing about the file at it.

**The definitions pin is unchanged and still load-bearing.** A remote server can
redefine its tools at any moment with no user-visible event, exactly like a local
one, so the sha256 over name + description + inputSchema, and the
`tools/list_changed` invalidation, carry over verbatim.

## Decision 3: a remote server is BOUNDED EGRESS, and badged as one

This is the decision that matters most, and getting it wrong would quietly turn
"add a Gmail tool" into "your memories now go to a third party" without the user
seeing it.

A stdio server is a local program that might do anything with your data. A
remote server **sends your data off the machine by definition**. Therefore:

- The server's origin is classified by `classifyEndpoint`, and it is **bounded**.
  A remote MCP server can never be `private`.
- Arguments are redacted at the **conversation's full active tier** before they
  are sent, not merely the deterministic Tier-1 floor stdio gets. We know the
  destination, so the normal rules apply rather than a fallback.
- The privacy ceiling binds it. A conversation pinned private cannot call a
  remote MCP tool at all, the same way it cannot reach a bounded model.
- Every call names the host in the approval prompt and in the "what left this
  machine" proof, like `web_fetch`.
- `trust: 'trusted'` is **not offered** for remote servers. That setting exists
  so the vault's own local server can receive real content; it makes no sense
  for a third party and would be a foot-gun.

## Decision 4: the SDK owns the OAuth protocol; we own storage and the redirect

`@modelcontextprotocol/sdk` already ships `client/auth.js` with metadata
discovery, protected-resource discovery, PKCE and the `OAuthClientProvider`
interface. We implement that interface rather than the protocol, which keeps the
security-sensitive parts (PKCE, state, token exchange) in reviewed upstream code.

Our half:

- **Tokens live in the Keychain**, under a sibling service to the existing
  `northkeep-provider-key` used for model API keys. They are **never** written to
  `mcp.json`, which is the plaintext-secret trap KNOWN-LIMITS already warns
  about for `--env`.
- **The redirect is loopback**, hosted by the GUI server, which is already a
  loopback listener with a session token. The redirect URI is registered per
  server, and a callback whose `state` does not match a pending request is
  refused.
- **Refresh is automatic; failure is loud.** An expired grant must surface as
  "reconnect this server", never as a tool that silently stopped working
  (invariant #6).
- Where a server requires a pre-registered client (Google does), the client id
  is configuration and any client secret goes to the Keychain beside the tokens.

## Decision 5: the OAuth flow IS the human gate for adding a remote server

ADR 0034 gated GUI adds because naming an executable converts a token leak into
code execution, and it wanted something an automated caller cannot produce.

A remote server spawns nothing, so that rationale does not transfer. But the
property still holds by a different route, and more strongly: **a remote server
cannot do anything until a human completes a browser sign-in.** An automated
caller holding a session token can write a URL into the config and still reaches
a dead end — no token, no tools, nothing runs. Adding therefore needs no
passphrase; the sign-in is the out-of-band confirmation.

What the UI must do instead is be loud about the *consequence*: name the host and
show the scopes being granted before the browser opens, because the risk here is
not execution, it is disclosure.

## What this does not do

- **No dynamic client registration by default.** The SDK supports it; enabling it
  means registering with an auth server we have not seen. Deferred until there is
  a concrete need, and it gets its own review.
- **No mobile implementation in this milestone.** The phone is the reason to
  build this, but it needs its own token store (expo-secure-store) and an app
  scheme redirect rather than a loopback one. Desktop first, phone next, and
  the trust decisions above are written so the phone inherits them unchanged.
- No stdio changes. Local servers keep the ADR 0033 model exactly.

## Honest limits

- **A remote server sees your arguments in plaintext after redaction.** Tier 2/3
  masks names and secrets; it cannot make free text anonymous. Asking a Gmail
  tool to "find the thread with my landlord about the lease" tells that server
  you have a landlord and a lease.
- **Results come back into the conversation** and then go to whichever model
  answers, under that chat's tier. Reading email through a remote server and
  answering with a cloud model means the email content reaches two third
  parties, not one. The proof must make both visible.
- **Removing a server here does not revoke the grant.** The token is revoked at
  the provider (your Google account), and the UI must say so rather than imply
  that deleting a row ends the access.
- **TLS authenticates the origin, not the operator's behaviour.** A legitimate
  server can still log everything you send it. That is a trust decision about
  the vendor, and no protocol setting substitutes for it.
- A compromised or malicious server sees exactly what you send it, which is why
  the redaction tier and the per-call prompt still matter even for a first-party
  host.

## Acceptance test (Jay runs this himself)

1. `northkeep mcp add gmail --url https://gmailmcp.googleapis.com/mcp/v1` stores
   the origin and reports that it needs connecting.
2. Connecting opens a browser, completes Google sign-in, and stores the token in
   the Keychain. `mcp.json` contains no secret.
3. `northkeep mcp tools gmail` lists the real tools; approving pins them.
4. A chat pinned **private** refuses to call it, naming the ceiling.
5. On a bounded chat, a call names the host in the prompt, and the turn's proof
   shows exactly what went to that host.
6. Revoking the grant in the Google account makes the next call fail loudly with
   "reconnect", not silently.
7. `plain http` and a loopback URL are both refused at add time.
