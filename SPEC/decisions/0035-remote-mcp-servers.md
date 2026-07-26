# ADR 0035: Remote MCP servers over HTTPS, with OAuth

- **Date:** 2026-07-25 (rewritten the same day after adversarial review)
- **Status:** Proposed
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0033 (MCP client trust model), ADR 0034 (adding servers from the GUI)

> **Rewrite note.** The first draft of this ADR argued that remote MCP "reuses
> more machinery than stdio did" and that "the OAuth sign-in IS the human gate."
> An adversarial review showed the first claim was wrong on three of its four
> specifics and the second was false outright. Both are corrected below rather
> than softened, because the original wording would have told an implementer
> this milestone was mostly free. It is not.

## Context

M11 shipped stdio only. Three things argue for remote servers, and the strongest
is not the one that prompted the question.

**Tools on the phone are otherwise impossible.** iOS forbids spawning child
processes, so stdio MCP can never run there. The alternative was a Mac relay: the
phone asks a paired, awake Mac to run the tool loop, which needs a new listening
surface on the desktop and its own review. Remote MCP reaches the same place with
the phone speaking HTTPS directly. This alone justifies the milestone.

**The official servers are remote.** Google's Gmail MCP server is HTTP with OAuth.
Stdio-only means a user hands their own Google Cloud OAuth credentials to a
community package instead of using the first-party server with a scoped token
they can revoke from their account.

### What is actually reused, and what is new work

The first draft claimed broad reuse. Corrected against the code:

| Mechanism | Reused? |
| --- | --- |
| Definitions pin + `tools/list_changed` invalidation | **Yes, verbatim.** `pinTools` is transport-agnostic. |
| Untrusted-content fence on results | **Yes.** `task.ts` keys the fence on "a tool produced this", not on having a URL. |
| Exfil screens over argument **body leaves** | **Yes**, exactly as for stdio. |
| Secret hard-block, approval protocol, content-free audit, namespacing | **Yes.** |
| Exfil screens' **URL decomposition** | **No.** MCP arguments ride a JSON-RPC POST body; the URL is a constant endpoint. Decomposition screens nothing. This is the same position stdio is in. |
| **Per-host grants** | **No.** `task.ts` and `policy.ts` prefer the server subject whenever one exists, so a grant is remembered against the user-chosen **label** — which ADR 0033 says is explicitly not an identity. See Decision 6. |
| **Privacy ceiling** | **No.** It filters model endpoints only (`route.ts`), and `PermissionRequest.modelTier` is passed at `task.ts:682` and read nowhere. It does not bind tool calls today, for any tool. See Decision 3. |
| **Full active redaction tier on arguments** | **No.** Tool egress applies the deterministic Tier-1 floor only, for every tool including `web_fetch`. See Decision 4. |
| **SSRF guard (`net.ts`)** | **No.** The SDK transport calls bare `fetch`. This is new work, not inheritance. See Decision 5. |

The honest summary: remote MCP inherits the *definition-and-result* protections
intact and inherits **none** of the egress protections automatically. Four of the
five things below are new code.

## Decision 1: HTTPS streamable HTTP, and a positive classification check

Transport is MCP streamable HTTP over **https** only. Not SSE, not WebSocket, not
plain http.

The first draft refused "plain http, including loopback." That is a string check
on a network property and does not hold. Verified against the shipped
`classifyEndpoint`:

- `https://192.168.1.1/mcp` → **private** (so the first draft's "a remote server
  can never be private" was simply false)
- `https://127.0.0.1.nip.io/mcp` → **bounded**, a public DNS name resolving to
  loopback, for which anyone controlling the domain can obtain a valid DV
  certificate

So the rule is a **positive check, applied at add time and again at every
reconnect** (DNS changes underneath a stored config):

1. `classifyEndpoint(url).tier` must be **bounded**. Anything else is refused.
2. The host must not be a bare IP literal, `localhost`, `.local`, or `.internal`,
   mirroring `net.ts`.
3. Scheme must be `https`.

A server that lives on this machine should be configured as **stdio**, where the
launch fingerprint provides real identity.

## Decision 2: identity is the origin, and TLS is not the stdio fingerprint

Identity is the **exact origin** (scheme, host, port), matched exactly, no
wildcards, no subdomain inheritance, inheriting policy.ts's rule and rationale.

The first draft called this "genuinely stronger than the stdio fingerprint."
That was wrong, and the correction matters because the two answer different
questions:

> TLS authenticates that we are talking to whoever currently controls this name,
> and that nobody on the network path can read or alter the exchange. It says
> nothing about **who** that party is, whether it is the same party as
> yesterday, or what code runs behind it. A DV certificate proves control of a
> name at issuance, not identity or continuity: a domain can change hands, a CDN
> can terminate TLS for a party you never evaluated, and a DNS takeover yields
> both the address and, via DNS-01, the certificate.

The stdio fingerprint answers "has this configuration changed since you approved
it." TLS answers "am I talking to whoever holds this name now." Neither
substitutes for the other, and remote MCP as specified has **no** change-detection
mechanism until Decision 6 adds one.

## Decision 3: a remote server is bounded egress, and the ceiling binds it

A stdio server is a local program that might do anything with your data. A remote
server **sends your data off the machine by definition**. Therefore:

- A remote origin must classify **bounded** or it is refused (Decision 1).
- `trust: 'trusted'` is **not offered** for remote servers. This is sufficient to
  keep the Tier-1 argument floor on, since `mcpStrict` computes `trust !==
  'trusted'`.
- Every call names the host in the approval prompt and in the egress proof.

### Does the privacy ceiling bind tool egress? (decided)

The first draft asserted "a conversation pinned private cannot call a remote MCP
tool at all, the same way it cannot reach a bounded model." **There is no such
enforcement, for any tool.** ADR 0011's ceiling filters model endpoints, and its
purpose is to stop the router from *silently* escalating. A tool call is never
silent — it stops, names the host, and waits.

So the real question is whether the word "private" promises more than the
mechanism delivers. **DECIDED by Jay 2026-07-25: option A for web tools, option
B for remote MCP.** The options as posed:

- **A — the ceiling governs which model reads the conversation, and nothing
  more.** Ships today. Keeps local-model-plus-web-search, which is the best
  privacy/utility combination the product has. Cost: "private only" needs an
  honest caveat in the UI and KNOWN-LIMITS.
- **B — the ceiling governs all egress.** Pin private and network tools are
  unavailable. The label becomes literally true. Cost: removes a genuinely useful
  combination and changes shipped 0.17.0 behaviour.
- **C — blocked by default with an explicit per-call override.** Keeps both;
  costs complexity, and raises whether a ceiling you can click through is a
  ceiling.

**Chosen: A for web tools, B for remote MCP.** A search query is transient,
masked and near-anonymous. A connected MCP server is a persistent, authenticated
third party holding a scoped grant to your accounts and returning your email or
documents *into* the conversation. The new capability starts with the stricter
rule, since tightening later is far harder.

### What that decision obliges, on each side

**Option A creates an obligation in the SHIPPED build, not a future one.** If the
ceiling does not stop web tools, the product must stop implying that it does. The
GUI told users "Private only is on … nothing is sent to any cloud or outside
model", which a reader takes as "nothing is sent". Corrected 2026-07-25 to state
both halves: local models only, and web tools still leave with per-call approval.
KNOWN-LIMITS carries the same sentence. Nothing else about option A is work.

**Option B is new code in the loop.** `withinCeiling` takes an `EndpointConfig`
and structurally cannot express a tool call, so the refusal has to live where the
loop evaluates a tool: when the conversation's ceiling is `private-only` and the
tool is a remote MCP tool, the call is refused before the gate, with a reason
naming the pin — not a silent skip, and not a prompt the user can click through,
because the point of the pin is that this class of egress is off the table.

Note the asymmetry is deliberate and must be visible to the user: in a
private-pinned chat, a web search asks and a remote MCP tool refuses. If that
reads as arbitrary in practice, revisit it — but revisit it in the direction of
tightening web tools, not loosening MCP.

## Decision 4: the argument floor is Tier 1, and a degraded higher tier must refuse

The first draft promised "the conversation's full active tier." No such path
exists: `task.ts` applies `applyTier1` to argument string leaves for every tool.

This ADR does **not** invent one. Remote MCP gets the same deterministic Tier-1
floor stdio gets, and this document says so plainly rather than implying more.

If Tier-2/3 egress redaction is wanted later, it must ship with its refusal rail:
**if the active tier is 2 or 3 and the NER model is unavailable, the call
refuses.** It must never degrade silently to Tier 1, which is invariant #6 and
the reason ADR 0033 carries the same amendment.

## Decision 5: remote MCP egress goes through our own guard, as new work

ADR 0028's architecture rests on every `web_fetch` byte passing through one file.
The SDK transport calls bare `fetch` (`streamableHttp.js`), so remote MCP would
otherwise be a **second, unguarded egress path**. Verified: the transport happily
connects to a private address.

Required:

- Pass a **custom `fetch`** to the transport (the SDK accepts one) that resolves
  the host, refuses if **any** answer is private, and dials the pinned address —
  the `net.ts` logic generalized to POST and `text/event-stream`.
- Route **OAuth discovery through the same guard**; those fetches default to bare
  `fetch` too.
- `hardenedFetch` **cannot be reused as-is**: it is GET-only, its port allowlist
  is 443/8443, and its content-type allowlist excludes `text/event-stream`.

## Decision 6: origin-change detection replaces the launch fingerprint

Grants for an MCP tool key on the server **label** (`policy.ts`), not the host. For
stdio, the launch fingerprint made that safe: change the command and the grants
stop applying. Remote MCP has no equivalent, so editing a URL in `mcp.json` would
carry `always` grants to a different host.

Therefore: **store the approved origin, re-check it at every connect, and
invalidate remembered approvals when it changes**, mirroring
`McpFingerprintChangedError`. Without this, Decision 2's identity claim has no
enforcement.

## Decision 7: the OAuth flow is NOT the gate — the gate is explicit

The first draft claimed a remote server "cannot do anything until a human
completes a browser sign-in." That is false, and it was the central argument for
waiving ADR 0034's passphrase.

Three holes, all verified:

1. `POST /api/mcp/inspect`, `/accept` and `/safe-read` are **token-only**. ADR
   0034 gated *adding*; nothing after it.
2. **Nothing requires a server to demand authentication.** A server that serves
   `tools/list` unauthenticated puts its tool definitions in front of the model
   with no OAuth at all — and ADR 0033 calls definitions the more dangerous
   surface precisely because the model reads them while deciding what to do.
3. The SDK lets the **server name its own authorization server**
   (`authorization_servers[0]` is not constrained to the server's origin). So
   `inspect` is a primitive that opens the user's browser at an attacker-chosen
   URL, from a trusted local app, framed as NorthKeep connecting an account.

ADR 0034's property is quoted here because this ADR must satisfy it, not
reinterpret it:

> Adding an MCP server must require something an automated caller cannot
> produce, **even holding a valid session token**.

Therefore:

- **A remote server contributes nothing — not even a tool listing — until a
  completed OAuth token exists** in the Keychain for it. `inspect` on an
  unconnected remote server does not connect.
- **Connecting requires the passphrase**, the same out-of-band proof ADR 0034
  uses for a free-form path. The browser flow is a step, not the gate.
- **A server that serves tools unauthenticated is refused**, with: "this server
  asks for no credentials; NorthKeep will not use it."
- **The authorization server must be same-origin with the MCP server**, or its
  origin is displayed verbatim and requires an explicit click before any browser
  opens.

## Decision 8: OAuth storage, redirect, and what that actually costs

The SDK owns discovery, PKCE, state and token exchange; we implement
`OAuthClientProvider`. What that requires, which the first draft omitted:

- **Tokens in the Keychain**, sibling to `northkeep-provider-key`, never in
  `mcp.json`.
- **A fixed callback port.** The GUI server binds a *random* port
  (`port ?? 0`), but `redirectUrl` is fixed and many providers require exact
  pre-registration. The callback needs a dedicated, stable loopback port.
- **A new unauthenticated route.** A browser redirect cannot carry
  `x-northkeep-token`, so `/oauth/callback` must be exempt from the token gate,
  and the CSP (`default-src 'none'; form-action 'none'`) needs treatment for that
  page. `state` matching is necessary but is not authentication.
- **The CLI has no GUI server.** `northkeep mcp connect` must stand up its own
  ephemeral loopback listener (RFC 8252). This is a second listening surface and
  must be said out loud, since this ADR's own Context sells remote MCP as
  avoiding one.
- **Dynamic client registration is not optional in practice.** The SDK throws
  when client information is absent and cannot be saved, so "no DCR" means every
  server without a pre-registered client id fails to connect. Scope it
  deliberately.
- **Refresh races.** Two surfaces refreshing one grant can write a stale refresh
  token over a rotated one and destroy the grant. Needs a single-writer token
  store or a per-server lock.
- **Keychain is macOS-only.** Refresh tokens rotate, so the env-var fallback used
  for tests is not viable. Linux/Windows have no token store under this design.

## Decision 9: config schema

`McpServerConfig` requires a non-empty `command` and a 64-hex `fingerprint`, and
the loader drops entries lacking them. Remote entries have neither, so the config
becomes a **discriminated union** on transport. Note that `loadMcpConfig` returns
zero servers for any `version` it did not write, so a version bump makes an older
build see no servers at all: prefer extending version 1.

## Dependencies (invariant #7)

ADR 0033 argued no new networked dependency because the MCP SDK was already
in-tree for the **server** direction. **That argument does not carry here.** This
milestone activates the SDK's HTTP client, its OAuth client, and its discovery
fetches — outbound network code we did not write. Under invariant #7 that is a
networked dependency in substance and needs Jay's explicit OK, which this ADR
requests.

## Honest limits

- Remote MCP egress does not use the `net.ts` guard unless Decision 5 ships.
- The privacy ceiling does not bind tool calls today, for any tool.
- Tool-egress redaction is the deterministic Tier-1 floor, not the active tier.
- The proof names the **endpoint**, which is constant, not the arguments. "We can
  prove what we sent" is weaker here than for `web_fetch` unless the proof
  carries the redacted argument payload.
- A remote server sees your arguments in plaintext after redaction. Tier 2/3
  masks names and secrets; it cannot make free text anonymous.
- Results re-enter the conversation and then go to whichever model answers, so
  reading email through a remote server and answering with a cloud model
  discloses to two third parties, not one.
- Removing a server here does **not** revoke the grant; that happens at the
  provider.
- No spend or call cap, carried from ADR 0033 and worse here, since each call is
  a network request to a third party.
- Keychain storage is macOS-only.
- Every remote server is a network dependency: it fails offline, and its latency
  sits inside the loop's request timeout.

## Invariant #1

Invariant #1 says plaintext memory content never leaves the machine except to
"the model provider the user explicitly selected, after the active redaction tier
has run," or to explicitly shared scopes via the connector. **A remote MCP server
is a third recipient that the invariant as written does not contemplate.**

**RESOLVED 2026-07-25.** Jay approved an explicit clause (c) in CLAUDE.md
covering the arguments of tool calls to a server the user explicitly connected
that runs **off** this machine — after the tool-egress redaction floor, only for
calls the user allowed, and receiving those arguments only: never the vault,
never the conversation. A tool server running ON this machine is not an
exception at all, because nothing leaves, which is why stdio MCP never
implicated this invariant.

This is a real widening, and it is recorded as one: NorthKeep now says your
memories can reach a third party you connected, under approval, in
argument-sized pieces, where before it said they could not at all.

## Acceptance test (Jay runs this himself)

1. Adding `https://gmailmcp.googleapis.com/mcp/v1` stores the origin and reports
   that it needs connecting. Adding an http URL, a bare IP, a `.internal` host,
   or a name that resolves private is refused with the reason.
2. Before connecting, `northkeep mcp tools gmail` does **not** contact the server.
3. Connecting asks for the passphrase, then opens the browser. The auth-server
   origin is shown before it opens.
4. After sign-in, tools list; approving pins them. `mcp.json` contains no secret.
5. A call names the host in the prompt, and the proof shows the host plus the
   redacted arguments that went to it.
6. Editing the stored URL invalidates remembered approvals and re-asks.
7. Revoking the grant at Google makes the next call fail loudly with "reconnect".
8. A test server that serves `tools/list` without authentication is refused.
