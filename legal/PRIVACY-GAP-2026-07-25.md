# Privacy policy gap: features shipped after the reviewed version

**For:** counsel review before the 0.17.0 build reaches design partners (Monday).
**Prepared:** 2026-07-25. **Not legal text** — a description of what changed and
what the current policy does not cover, so counsel can draft or approve wording.

## The situation

`legal/PRIVACY.md` carries an effective date of **17 July 2026**. Two milestones
merged on **25 July 2026** that create data flows the policy does not describe.
Partners are currently on the 17 July build, so **nothing is live under an
inaccurate policy today**; the gap has to close before the 0.17.0 build is
distributed.

Searching the reviewed policy for `web`, `search`, `tool`, `MCP`, `fetch` and
`third part` returns **zero matches**.

## What changed in the product

### 1. Web search and web fetch (M10)

The user may enable "tools". When enabled, the model can ask to:

- **Search the web.** The search query is sent to **Brave Search** (a third-party
  API) over HTTPS, authenticated with a key the user supplies and NorthKeep
  stores in the macOS Keychain.
- **Fetch a web page.** An arbitrary URL, chosen by the model, is requested
  directly from that site.

Controls that already exist and are user-visible: tools are **off by default**;
every call is screened for secret shapes, protected names and vault content
before it runs; the user approves each call at a prompt showing the exact query
or URL, unless they have granted that specific site "always", which they can
revoke; the arguments are masked by a deterministic redaction pass before they
are sent; a per-turn proof shows exactly what left; and a content-free audit log
records that the call happened without recording its content.

**Recipients created:** Brave Search (queries), and any website the user allows a
fetch to (the URL, plus whatever a normal HTTP request discloses, e.g. IP
address).

### 2. MCP tool servers (M11)

The user may connect "MCP servers" — programs that expose tools to the model.
Today these are **local programs on the user's own Mac** that the user installs
and configures (NorthKeep's own vault server is the built-in example). The
arguments of an approved tool call are passed to that program.

Two points counsel should weigh:

- A local MCP server is a **program the user installed**, running with their
  privileges. Many third-party MCP servers wrap a cloud API, so such a program
  may forward what it is given to a third party. That is the program's own
  egress, not NorthKeep's, but a user may not draw that distinction.
- NorthKeep applies its redaction floor to arguments before a "strict" server
  sees them, and never sends such a server the vault or the conversation.

**Recipients created:** whatever program the user chose to install and connect,
and by extension whatever that program contacts.

### 3. Remote MCP servers (M12) — UPDATED 2026-07-25, later the same day

**This section previously said remote MCP was specified but not implemented.
That is no longer true, and the change is material enough that counsel should
re-read this section rather than the earlier version.**

Remote MCP servers (ADR 0035) are now implemented. The user can add an HTTPS MCP
endpoint — Google's Gmail MCP server is the motivating example — sign in to it
with OAuth, and let approved tool calls run against it. This creates a **direct
NorthKeep-to-third-party data flow**, which the two milestones above did not:

- The arguments of an approved call are sent **from this machine to that
  provider**, after the deterministic Tier-1 redaction floor.
- An **OAuth grant** to the user's account at that provider is created and
  stored in the macOS Keychain. It is a standing, scoped authorization, not a
  one-off, and NorthKeep cannot revoke it — the user does that at the provider.
- Results come back **into the conversation**, and then travel to whichever
  model answers. Reading email through a remote server and answering with a
  cloud model therefore discloses to **two** third parties, not one.

User-visible controls, stated precisely because two earlier drafts of this
paragraph overstated them:

- A remote server is **not contacted at all** until the user starts a sign-in,
  and starting one **requires the vault passphrase**. (During the sign-in itself
  the server is contacted, before any grant exists — that is what a sign-in is.)
- Its arguments always get the deterministic **Tier-1 floor**, and it can never
  be marked "trusted".
- A conversation pinned **"Private only" refuses its tools outright.**
- Each call is approved at a prompt naming the server and its origin, **or runs
  under a standing grant** the user created at such a prompt and can revoke.
  **A standing grant means no prompt on later calls**, which is the honest
  version of "each call is approved" and matches how the same mechanism already
  works for web tools. Only tools the user has explicitly marked read-only can
  hold one; anything else asks every time and cannot be remembered.
- The per-turn proof names the **connected server and its origin** plus the
  redacted arguments that went to it.

**For point 4 below, this means the MCP paragraph must cover two cases, not one:
software the user installs locally, and a remote service the user grants access
to their account at.** The second is the stronger disclosure and the one with an
ongoing authorization attached.

## What the policy would need to cover

Counsel to decide the form; the substance appears to be:

1. That an **optional, off-by-default** feature can transmit user-directed
   queries and URLs to third parties the user approves per call.
2. That **Brave Search** is a processor/recipient when web search is used, and a
   pointer to their policy.
3. That a **fetched website** receives the request and standard request metadata.
4. That **MCP servers the user connects** receive the arguments of calls the
   user approves, that they are third-party software or services not operated by
   NorthKeep, and that what they do with that data is governed by their own
   terms. Two sub-cases (see section 3): a **local program** the user installs,
   and a **remote service** the user signs in to, where NorthKeep transmits
   directly to that provider and the user's account there holds a standing OAuth
   grant that only they can revoke.
5. That NorthKeep applies redaction and screening before transmission, but that
   these reduce rather than eliminate disclosure — the policy already uses this
   framing for the model provider and it is consistent.
6. Whether any of this constitutes a change requiring **notice before it takes
   effect** under the policy's own "Changes" section, which currently promises
   advance notice for material changes.

Point 6 is the one I would flag hardest: the policy makes a promise about how
changes are communicated, and this is the first change since it was written.

## Corresponding internal change

`CLAUDE.md` invariant #1 was amended the same day to acknowledge this recipient
class explicitly, rather than let a new data flow sit outside the stated rule.
The invariant now covers "the arguments of a tool call the user allowed", after
screening and masking, and states that it bounds what NorthKeep transmits — a
local program forwarding data onward is that program's egress. Counsel may wish
the public policy to track that same distinction.

## Suggested sequence

1. Counsel drafts or approves the added section.
2. Update `legal/PRIVACY.md`, bump the effective date, and regenerate
   `site/privacy.html` from it so the two cannot drift.
3. Decide whether partners need notice before Monday's build, per point 6.
4. Then distribute 0.17.0.
