# ADR 0035: Remote MCP servers over HTTPS, with OAuth

- **Date:** 2026-07-25 (rewritten the same day after adversarial review)
- **Status:** Accepted and implemented 2026-07-25 (M12)
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0033 (MCP client trust model), ADR 0034 (adding servers from the GUI)

> **Invariant #7 sign-off.** The Dependencies section below asks for Jay's
> explicit OK to activate the MCP SDK's HTTP client, OAuth client and discovery
> fetches. Given 2026-07-25 ("Build 0035"), after the adversarial review that
> produced this document's corrections. Recorded here rather than in a commit
> message so the approval sits with the argument it approved.

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

**Amended 2026-07-25, after review, because the first wording claimed a check
the add path does not perform.** These three are *syntactic*: they read the URL
and classify the name. `classifyEndpoint` returns `bounded` for any "public or
unrecognized host" **without resolving it**, so `https://127.0.0.1.nip.io/mcp`
passes this check and is *not* refused at add time.

The refusal for a name that RESOLVES private lives one layer down, in the
transport guard (Decision 5): `guardedFetch` resolves the host at connect time,
refuses if **any** answer is private, and dials the pinned address. That is the
better place for it — the answer is fresh, and it is the same code path that
carries the guarantee for every subsequent request rather than a snapshot taken
once when the server was added.

Stated as a division of labour so no one reads either half as the whole:
`remoteUrlRefusal` refuses the *shapes* that can never be legitimate (http, bare
IPs, local names, credentials in the URL, a non-bounded classification);
`guardedFetch` refuses the *addresses* that turn out to be private, every time it
connects. Acceptance test 1 is amended to match: a name that resolves private is
refused **at connect**, with the reason, not at add.

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
  **Was false when first written, now true.** An audit on 2026-07-25 found both
  surfaces showing only the user-chosen LABEL ("gmail"), because an MCP tool's
  `egress()` returns null and there was no host field to render. Rather than
  soften the claim, `ApprovalRequest.serverOrigin` and the proof's `mcpOrigin`
  were added and both surfaces now render `mcp server "gmail" at
  https://mcp.example.com`. A stdio server has neither field, and that absence
  is itself the statement that nothing left the machine.

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

  **VERIFIED EMPIRICALLY 2026-07-25, not merely implemented.** A test written
  against `https://mcp.example.com` failed with `FetchRefusedError('dns')`
  raised from `guardedFetch`, through the SDK's own
  `discoverAuthorizationServerMetadata` → `fetchWithCorsRetry` call chain. That
  stack trace is the proof that the SDK honours `fetchFn` for discovery, which
  is the part of this decision with the least test coverage behind it and the
  part most easily assumed rather than checked.
- `hardenedFetch` **cannot be reused as-is**: it is GET-only and its
  content-type allowlist excludes `text/event-stream`. **Correction:** this
  originally listed the 443/8443 port allowlist as a third reason.
  `guardedFetch` shares that allowlist deliberately (both call
  `classifyFetchTarget`), so it was never relaxed — which means **a remote MCP
  endpoint or authorization server on any other port is refused.** That is the
  intended behaviour, but it is a real constraint on which providers can be
  used, and listing it as a difference implied otherwise.

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

> Causing NorthKeep to spawn an **attacker-chosen program** must require
> something an automated caller cannot produce, **even holding a valid session
> token**.

A remote server spawns nothing, so the literal property is not the binding one
here. The equivalent for remote is: **an automated caller must not be able to put
an attacker-chosen server's tool definitions in front of the model, nor cause a
browser to open at an attacker-chosen URL.** Both are exactly what the holes
below allow, which is why the gate has to be explicit.

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

  **AMENDED IN IMPLEMENTATION, and this is a better answer than the one above.**
  Neither of the previous two bullets was built as written. There is no
  `/oauth/callback` route on the GUI server and no CSP carve-out: instead ONE
  short-lived listener (`awaitOAuthCallback`, `oauth.ts`) binds 127.0.0.1 on a
  fixed port only while a connect is in flight, answers exactly one request, and
  closes. The CLI and the GUI use the same code.

  Three things improve at once. The GUI's token gate and its `default-src 'none'`
  CSP are never relaxed. There is no permanently-open unauthenticated route to
  reason about — the window in which anything can talk to that port is the
  seconds between opening the browser and finishing sign-in. And the "second
  listening surface" the bullet above conceded is not two surfaces but one,
  shared, so it cannot drift between the CLI and the GUI.

  What it costs: the port is fixed (8788), so two NorthKeep sign-ins at the same
  instant collide, and the second reports the port is in use rather than
  silently doing something surprising. A fixed port is not optional — providers
  require an exactly pre-registered redirect URI, and the GUI's own port is
  random.
- **Pre-registered client credentials are REQUIRED, not a fallback.** Google's
  documentation states plainly that its remote MCP servers "don't support
  Dynamic Client Registration or OAuth Client ID Metadata Documents": the user
  creates a Google Cloud project, configures a consent screen, creates an OAuth
  client ID and secret, and registers a redirect URI. Claude requires the same
  (a custom connector with the client id and secret pasted in). So supporting
  BYO client credentials is the primary path for the flagship server, and DCR is
  the optional extra rather than the reverse. The SDK also throws when client
  information is absent and cannot be saved, so a provider offering neither
  simply cannot connect.

  **Product consequence worth stating in the UI:** there is no zero-config
  official path, for anyone. No client can perform the Cloud console setup on the
  user's behalf. The honest promise is "paste the two values you created", not
  "connect Gmail in one click".
- **Refresh races.** Two surfaces refreshing one grant can write a stale refresh
  token over a rotated one and destroy the grant. Needs a single-writer token
  store or a per-server lock. **Implemented as an in-process write chain**
  (`updateCredentials`), which serializes the CLI's own writers and the GUI
  server's own writers. It does **not** serialize the CLI against a running GUI:
  two processes refreshing the same grant in the same instant can still lose a
  rotation. Recorded in KNOWN-LIMITS rather than solved with a lock file, whose
  stale-lock recovery would be its own failure mode.
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

*Two entries here were written before the implementation and were left standing
after it contradicted them — corrected 2026-07-25 rather than deleted, so the
drift is visible.*

- ~~Remote MCP egress does not use the `net.ts` guard unless Decision 5 ships.~~
  **Decision 5 shipped.** Every remote byte goes through `guardedFetch`.
- ~~The privacy ceiling does not bind tool calls today, for any tool.~~ **It now
  binds exactly one class:** a `private-only` conversation refuses remote MCP
  tools. Web tools and stdio servers are unaffected, which is option A / option
  B as chosen.
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

> **Implementation note on what is stored.** The config keeps the endpoint —
> scheme, host, port and PATH — with query and fragment dropped. IDENTITY is
> still the origin (`endpointOrigin()`), and that is what the stored credentials
> are bound to and what a change invalidates. Storing the bare origin, as the
> first draft implied, would have produced a config that cannot connect at all,
> since a real endpoint is `https://host/mcp/v1`.

1. Adding `https://gmailmcp.googleapis.com/mcp/v1` stores the origin and reports
   that it needs connecting. Adding an http URL, a bare IP, or a `.internal`
   host is refused with the reason. A public name that RESOLVES to a private
   address is accepted at add time and refused at **connect** (Decision 1 as
   amended) — check both halves, since the split is deliberate.
2. Before connecting, `northkeep mcp tools gmail` does **not** contact the server.
3. Connecting asks for the passphrase, then opens the browser. The auth-server
   origin is shown before it opens.
4. After sign-in, tools list; approving pins them. `mcp.json` contains no secret.
5. A call names the server AND its origin in the prompt, and the proof shows
   both plus the redacted arguments that went to it.
6. Editing the stored URL stops the server working: its tools are not offered at
   all, so nothing prompts. (Decision 6 says "invalidates remembered approvals
   and re-asks"; what the code does is refuse the connection, exactly as
   `McpFingerprintChangedError` does for stdio. The grants stay in
   `permissions.json` and are simply never reachable. Same outcome, and the
   acceptance test says what you will actually see.)
7. Revoking the grant at Google makes the next call fail loudly with
   "reconnect". *(Amended by the 2026-07-27 acceptance run: providers honor
   already-issued access tokens until expiry, so the loud failure immediately
   after revocation may carry the server's own error text; the "sign in again"
   message appears once the token expires.)*
8. A test server that serves `tools/list` without authentication is refused.

## Adversarial review 2026-07-27

Second adversarial pass over the M12 OAuth work, verified against code rather
than against this document's prose. Five findings, all fixed in the same change
set, each fix carrying tests.

1. **guardedFetch destroyed URLSearchParams bodies.** `guardedFetch`
   JSON-stringified any non-string body, and
   `JSON.stringify(new URLSearchParams(...))` is `"{}"`, so the SDK's token
   exchange and refresh (which POST URLSearchParams as
   `application/x-www-form-urlencoded`) sent a body of `{}` to every token
   endpoint. Fixed: a URLSearchParams body is written as its urlencoded string,
   a Uint8Array or Buffer body is written byte for byte, a caller-set
   Content-Type is preserved, and any other body shape throws instead of being
   serialized on a guess. A fixture-server test round-trips an SDK-shaped token
   exchange and asserts grant_type, code, code_verifier and client_id arrive
   intact.

2. **The state parameter was never generated, so the callback's state check was
   dead code.** `KeychainOAuthProvider` implemented no `state()`, the SDK
   therefore omitted the parameter from the authorization URL, the connect flow
   read null from that URL, and the mismatch guard in `awaitOAuthCallback` could
   never run in production. Fixed: the provider issues a fresh 32-byte
   crypto-random state per attempt and remembers it (`issuedState`); the connect
   flow passes that provider-held value to the listener, and refuses to proceed
   if none was issued; a missing state on the callback, when one was issued,
   counts as a mismatch, fail closed. Tests cover a wrong state, a missing
   state, and that the authorization URL and the listener share one value.

3. **The browser could open before the loopback listener was bound.**
   `server.listen()` returns before the bind settles and EADDRINUSE arrives
   asynchronously, so if port 8788 was owned by another process, the user could
   complete a real sign-in whose authorization code was delivered to whatever
   owned the port. Fixed: `awaitOAuthCallback` now exposes a `ready` promise
   that settles when the socket is bound or the bind has failed, and `proceed()`
   awaits it before any browser opens. Port-in-use now fails with the browser
   unopened. Tested against the real port, including the timeout and
   one-request-then-close behaviour.

4. **SDK error recovery destroyed the working grant during a re-sign-in.** The
   SDK's `auth()` calls `invalidateCredentials('all' | 'tokens')` on
   InvalidClient, UnauthorizedClient and InvalidGrant errors. During a
   re-sign-in (`ignoreStoredTokens`), the stored record is the previous working
   grant, so a failed new attempt deleted exactly what the
   hide-instead-of-delete flow (commit 5e03cfc) exists to preserve. Fixed:
   while `ignoreStoredTokens` is set, `invalidateCredentials` leaves the stored
   tokens and client untouched and clears only this attempt's PKCE verifier;
   normal-path invalidation, an expired refresh token during ordinary use, is
   unchanged. Both directions are tested.

5. **The privacy ceiling failed open when a server vanished from the config
   mid-turn.** In the task loop, a tool carrying an `mcpServerId` that
   `getMcpServer` could not resolve classified as not-remote, so an
   already-connected remote tool could run in a Private-pinned conversation if
   its config row was removed mid-turn. Fixed: a tool whose server id resolves
   to nothing is refused as remote under the pin (unknown means it leaves, fail
   closed), with its own denial wording. Tested.

## Acceptance-test finding 2026-07-27 (real Google sign-in)

The first real sign-in attempt against Google's Gmail MCP server opened the
browser at `https://gmailmcp.googleapis.com/authorize` and got Google's 404
page. Root cause, found by reproducing the SDK's discovery calls through
`guardedFetch` outside the app: the pinned-DNS `lookup` override answered in
the two-argument shape `(address, family)` unconditionally, but Node 20+
enables `autoSelectFamily` by default, which invokes the override with
`{all: true}` and requires an array back. Every `guardedFetch` to a real
HOSTNAME therefore threw `Invalid IP address: undefined` before a packet was
sent; the SDK swallowed the failed discovery fetches, concluded the server
published no metadata, and fell back to the default `/authorize` path on the
server origin. Every unit test stayed green because every fixture dials
`127.0.0.1`, an IP literal, which skips the custom lookup entirely.

Fixed by honoring both callback shapes, the same contract `hardenedFetch`
already implemented (which is why M10 web tools never hit this). A canary test
now connects to a fixture through a hostname so the override actually runs.

Verified after the fix: `/.well-known/oauth-protected-resource/mcp/v1` on the
Gmail server resolves to `authorization_servers: ["https://accounts.google.com/"]`,
and accounts.google.com metadata yields the real authorization and token
endpoints. Consequence the UI must own: for Google the authorization server is
CROSS-ORIGIN from the MCP server, so the loud origin notice is the EXPECTED
path for the flagship provider, not an edge case.

Lesson, same family as the URLSearchParams blocker above: the loopback test
seam cannot exercise the DNS layer, so any change to the socket-level options
needs one probe against a real hostname before it is called done.

## Amendment 2026-07-27: what "demands authentication" means (Decision 7, hole 2)

The acceptance run surfaced a second finding, this one a design collision
rather than a bug. Decision 7 refuses "a server that serves tools
unauthenticated," and the probe implemented that as "the anonymous handshake
succeeds." Google's official Gmail server answers the anonymous handshake AND
serves its full tool list to anyone; only `tools/call` demands a token. As
written, the gate refused the flagship provider permanently.

Decision, approved by Jay 2026-07-27: a server counts as demanding
authentication when it publishes RFC 9728 protected-resource metadata naming
at least one authorization server. That document is the machine-readable
declaration "my API is gated by sign-in," and it is what the sign-in flow
consumes anyway. A server that neither publishes one nor refuses the anonymous
handshake is still refused with the original wording. What this deliberately
does not change: tool descriptions still reach the model only after a
passphrase-gated connect and an explicit review; the cross-origin notice still
shows; the probe still never lists tools.

Adversarial note, recorded so nobody reopens it: a hostile server could always
pass the old probe by answering 401, so the gate never defended against
auth-shaped hostile servers. It defends against credential-less endpoints, and
still does. A server that publishes metadata yet answers calls anonymously
gains nothing: after sign-in every call carries the token, and the user's
exposure is identical to any approved remote server.

Verified against the live Gmail endpoint after the change: the probe returns
"demands auth." Fixture tests pin both directions, including that the metadata
path never falls through to a handshake attempt.

## Acceptance run 2026-07-27: passed, with four product findings

The checklist in SPEC/M12-ACCEPTANCE.md was run against real Google and real
Cloudflare (see the run record there). Both OAuth shapes verified: a
user-created confidential client (Google) and dynamic client registration
(Cloudflare). Findings that are now tracked work, in priority order:

1. **No refresh token from Google.** Google requires its nonstandard
   `access_type=offline` query parameter before it issues a refresh token; the
   SDK sends only standard parameters, so a Google grant dies with its first
   access token (about an hour). The connect flow holds the authorization URL
   before opening the browser, so appending `access_type=offline` (and
   `prompt=consent`) there is possible without forking the SDK. Decide whether
   to append for all providers or detect Google; unknown parameters are
   ignored by compliant providers.
2. **The pasted client secret is not persisted.** A user-supplied secret was
   used transiently for the exchange and never saved, so even with a refresh
   token a confidential-client refresh could not authenticate, and every
   "Sign in again" required re-pasting. DCR clients store their registration
   (verified in the Cloudflare record). **FIXED same day:** `saveTokens` now
   persists the pasted client id and secret to the Keychain record at the
   moment the grant they were pasted for succeeds — never earlier, so a failed
   attempt cannot overwrite a working record — and preserves a stored DCR
   registration when nothing was pasted. Tested both directions. This also
   makes the privacy policy's "stored only in your operating system's
   keychain" sentence exactly true.
3. **Scope selection requests everything the server advertises.** The SDK
   defaults to joining `scopes_supported`; for Gmail that meant five scopes
   including `gmail.metadata` where Google documents two. Harmless in this
   run, but the flow should support a documented default and the existing
   `--scope` override end to end (the CLI has it; the GUI does not).
4. **The GUI has no control for marking a tool read-only.** The local API
   endpoint exists (`POST /api/mcp/safe-read`) but no frontend calls it, so
   GUI-only users cannot create the one grant type that stops repeat prompts;
   the CLI verb is `northkeep mcp safe-read`. UX decision, not security: the
   marking is a trust declaration and deserves the same weight in the GUI as
   in the CLI.

Also recorded in KNOWN-LIMITS: Google's Gmail MCP is Workspace-only AND
Developer-Preview-gated (tools/list answers anonymously while tools/call
denies, which reads as a client bug and is not); provider revocation takes
effect at token expiry; and a tool-incapable local model can fabricate tool
results with no egress, which the concierge's routing does not yet weigh.
