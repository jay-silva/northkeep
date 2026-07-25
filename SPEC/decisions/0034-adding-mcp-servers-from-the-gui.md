# ADR 0034: Adding an MCP server from the GUI

- **Date:** 2026-07-25
- **Status:** Accepted (implemented 2026-07-25)
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0033 (MCP client trust model)

## Context

M11 shipped MCP servers with a deliberate asymmetry: the GUI can review,
approve, restrict and remove a server, but only the CLI can add one. Removing
and restricting only ever narrow what can run, so they are safe anywhere;
adding names an executable to spawn.

That left a real product gap. Someone using only the NorthKeep desktop app has
no terminal, so they cannot use MCP at all. "Install the app, now open Terminal"
is not a shape this product accepts elsewhere, and M9 exists precisely because
it was not acceptable for model providers either.

### The risk, stated precisely

The vague version ("a browser form that spawns programs is dangerous") does not
survive contact with the actual threat model, and it is worth being exact
because the exactness is what makes a safe design possible.

- **A local process running as the user** can already write
  `~/.northkeep/mcp.json` directly and spawn anything it likes. An API route
  offers it nothing new.
- **A remote attacker** cannot reach the route. The session token rides a custom
  header, so no cross-origin form, image or script request carries it, and the
  Host check closes DNS rebinding.
- **A prompt-injected model** cannot reach loopback: `net.ts` refuses private
  addresses by design (ADR 0028), so `web_fetch` cannot POST to our own API.

So an add route is not a meaningful escalation against any attacker the design
currently stops. The narrow, genuine concern is different: **it converts a
confidentiality failure into persistent code execution.** If the SSRF classifier
ever had a gap — three have been found and fixed, CGNAT, `0.0.0.0/8` and `::` —
or a session token leaked, today's consequence is that someone reads memories.
With a free-form add route, the same bug writes a config entry naming a program
that runs with the user's privileges on demand and survives restarts. That is
the difference between a breach and a foothold, and it is worth engineering
against even though every path to it is currently closed.

One mechanical detail shapes the design: **adding does not spawn; inspecting
does.** An unreviewed server contributes no tools to a chat (ADR 0033), so the
dangerous sequence is `add` then `inspect`, where `connectServer` starts the
child. Break the first link and the rest is inert.

## The property this ADR preserves

> Adding an MCP server must require something an automated caller cannot
> produce, **even holding a valid session token**.

Note what this does NOT say. It does not say "the GUI cannot add servers", which
was M11's blunt instrument. It names the actual property, which turns out to be
satisfiable without giving up the feature.

## Decision 1: a catalog covers the common case, and never takes a path

Most users want exactly one MCP server: NorthKeep's own vault, so their chat can
search their memories mid-conversation. That path is not user input at all — we
know where our own server lives, because we are running from the same
installation.

So the GUI offers a **catalog** of known servers, mirroring the `KNOWN_PROVIDERS`
pattern M9 uses for model providers. The user picks an entry; **the command,
arguments and environment come from our template**, never from the request body.
The request carries only a catalog id.

The blast radius of the whole route collapses accordingly: an attacker who
somehow reaches it can add only servers we vetted, whose only effect is running
our own code, which grants them nothing they did not already have to have the
token in the first place. Catalog adds therefore need **no** extra
authentication, and the common path stays one click.

## Decision 2: a free-form path requires the passphrase

Naming an arbitrary executable is the case worth gating, so the GUI requires
**re-authentication with the vault passphrase** for it, verified through the same
derive-and-open path `/api/unlock` uses.

This is the load-bearing control, and it is chosen over the alternatives because
it satisfies the property above on **both** surfaces:

- A leaked token is not enough. A prompt-injected model is not enough. An SSRF
  bypass is not enough. All of them are automated callers without the
  passphrase.
- Argon2id at production parameters makes guessing impractical, and the ~1s cost
  is a feature on a route that should be used roughly once per install.
- It works identically in a browser and in the desktop app, so it does not
  depend on shipping native dialog plumbing first.

The verification is **side-effect free**: it derives, opens the vault to prove
the key is right, zeroes the key, and changes no session state. Re-authenticating
must never be a way to unlock, only a way to prove.

## Decision 3: the GUI restricts where a program may live; the CLI does not

For a free-form add from the GUI, the command must resolve inside an allowlisted
root: the app's own resources, `~/.northkeep/mcp-servers/`, or the standard
package prefixes (`/opt/homebrew`, `/usr/local`). Anything else is refused with
the reason, and the CLI is named as the way through.

This is a structural bound rather than a judgement call: even with the
passphrase, the GUI cannot be talked into `"/bin/sh" ["-c", "..."]`.

**The CLI stays deliberately unrestricted.** Someone at a terminal already has
code execution; a directory allowlist there would protect nobody while blocking
the legitimate case of a server checked out in a project folder. Guardrails
belong on the surface that is reachable by software, not on the one that already
implies a human with a shell.

## Decision 4: the GUI does not accept environment variables

`--env` values are stored in plain text in `mcp.json` and KNOWN-LIMITS already
warns against putting secrets there. A browser form invites exactly that mistake,
so the GUI form omits the field entirely; catalog templates may set what their
server needs, and anything else is a CLI concern.

## What this does not do

- No native OS confirmation dialog. A Tauri dialog the page cannot script would
  be the strongest form of "outside the web surface", but `main.rs` has no
  custom commands today, so it is new plumbing rather than a small change. The
  passphrase gate gives the same property against automated callers, which is
  what the threat model actually requires. Worth revisiting if a future feature
  needs out-of-band confirmation for its own reasons.
- No remote/http servers; ADR 0033's stdio-only limit stands.
- No auto-install of third-party servers. The catalog names things already
  present on the machine; it never downloads.

## Honest limits

- The passphrase gate stops automated callers, not a human at an unlocked
  machine. Nothing here changes the standing rule that your Mac login session is
  the wall.
- A catalog entry is still a program. Vetting means we chose it, not that it is
  incapable of harm; catalog servers go through the identical review, pin and
  approval flow as any other.
- Adding remains only the first of two steps. A server still offers no tools
  until its definitions are reviewed and approved (ADR 0033 Decision 2).

## Acceptance test (Jay runs this himself)

1. In Settings → Tools, "Add a server" lists the catalog with NorthKeep's own
   vault server. Adding it takes one click and no typing.
2. The added server shows as not reviewed, and offers no tools until approved.
3. Choosing a custom path asks for the passphrase. A wrong passphrase refuses
   and adds nothing.
4. A custom path outside the allowed roots is refused by name, with the CLI
   offered as the way through, even with the correct passphrase.
5. `curl` against `/api/mcp/add` with a valid token but no passphrase, naming
   `/bin/sh`, is refused.
6. The same free-form add still works from the CLI, unrestricted.
