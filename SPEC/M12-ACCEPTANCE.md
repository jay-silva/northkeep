# M12 acceptance — remote MCP servers (ADR 0035)

What I built and tested myself is listed first, so you know what this checklist
is and is not asking you to re-do. **The one thing I could not test is the part
that matters most: a real sign-in to a real provider.** Everything below the
line needs your hands.

## What I verified

Automated (77 files, all passing):

- The config is a discriminated union on transport. A pre-M12 entry with no
  `transport` field still loads as a stdio server with its command, args, cwd,
  env and fingerprint intact — your existing vault server is one of those, and
  the failure mode if I had got it wrong is "all my MCP tools vanished".
- `remoteUrlRefusal` refuses http, bare IPs (public and private), IPv6 literals,
  `localhost`, `.local`, `.internal`, embedded credentials, and unparseable
  strings. It keeps the endpoint path and drops query and fragment.
- A hand-edited `mcp.json` cannot smuggle in a remote entry marked `trusted`, or
  one with a URL the add route would have refused. Both are dropped on load.
- No secret reaches `mcp.json`: access token, refresh token, client secret and
  PKCE verifier are all asserted absent from the file.
- Two concurrent token refreshes inside one process serialize, so a rotation
  cannot be lost.
- A private-pinned conversation refuses a remote MCP tool before it runs, allows
  the same tool unpinned, and does **not** refuse a local stdio server.

In Chrome, against a running server:

- The Tools panel shows a remote server with its URL, "not connected", Sign in
  enabled and Review tools disabled.
- Adding `http://…` from the GUI is refused with the reason.
- A wrong passphrase starts no sign-in and clears the field. No console errors.

Manually from the CLI: add, refusals, `mcp list`, and `mcp tools` refusing to
contact an unconnected server.

---

## What you need to check

### 1. Adding a remote server (GUI)

Settings → Tools → "Add a remote server (https, sign-in required)".

- [ ] Add one with a bad address (`http://example.com`, `https://192.168.1.1/mcp`,
      `https://foo.internal/mcp`). Each is refused with a reason that says what
      to do instead.
- [ ] Add a real one. The card appears with the URL, **not connected**, and
      "Review tools" is greyed out.
- [ ] `cat ~/.northkeep/mcp.json` — the entry has `transport: "http"`, the URL,
      `trust: "strict"`, and **no secret of any kind**.

### 2. It really is inert before sign-in

- [ ] `northkeep mcp tools <id>` refuses, saying it has not been connected. This
      is the point of the whole gate: an unconnected remote server never gets to
      put its tool descriptions in front of the model.

### 3. Signing in (the part I could not test)

You need an OAuth client from the provider first. There is no way around this
and no client can do it for you — see the note at the bottom.

- [ ] Click **Sign in**. It asks for your **vault passphrase**, not just a click.
- [ ] A wrong passphrase gets you nothing and does not contact the server.
- [ ] With the right one, it shows you the sign-in address **before** opening a
      browser. If that address is not the server's own, it says so in red.
- [ ] It shows the exact redirect address your provider must have registered:
      `http://127.0.0.1:8788/oauth/callback`
- [ ] Click "Open the sign-in page", complete the provider's flow. The browser
      tab says "Signed in. You can close this tab."
- [ ] The card now says **signed in** and "Review tools" is enabled.
- [ ] `cat ~/.northkeep/mcp.json` again — still no secret. The tokens are in
      Keychain Access under `northkeep-mcp-oauth`.

### 4. Using it

- [ ] **Review tools** lists what it advertises. Accept the definitions.
- [ ] In a chat with Tools on, ask something that needs it. The approval prompt
      names the server **and its origin** — `mcp server "gmail" at
      https://gmailmcp.googleapis.com` — not just the label you chose.
- [ ] The proof line afterwards shows the same, plus the masked arguments that
      went to it.
- [ ] If you mark a tool read-only and answer "always", later calls to it run
      **with no prompt**. That is the same standing-grant mechanism web tools
      use, and it is worth seeing once so it is not a surprise later.

### 5. The refusals that matter

- [ ] Pin the chat **Private only** and ask again. The remote tool is **refused
      outright**, with a reason naming the pin — not a prompt you can click
      through. A web search in the same pinned chat still works and still asks.
      That asymmetry is the choice you made on 25 July.
- [ ] Edit the URL in `mcp.json` to a different host and try to use it. The
      server stops working entirely — its tools are not offered, so nothing even
      prompts. Remembered approvals cannot carry to a host you never approved.
- [ ] Revoke the grant at the provider, then use the tool. It should fail loudly
      and tell you to reconnect.

### 6. Nothing regressed

- [ ] Your existing vault MCP server still works in chat, in both the CLI and
      the GUI. (Automated test covers the config half; this covers the rest.)

---

## Two things to know before you start

**There is no zero-config official path, for anyone.** Google's own
documentation walks you through creating the OAuth client by hand; it never
offers dynamic registration. Claude's own Gmail connector requires exactly the
same two values. Anyone promising "connect Gmail in one click" is describing
something that does not exist. The GUI's honest promise is "paste the id you
created, and the secret when you sign in".

### The Gmail setup, concretely (checked against Google's docs, 2026-07-25)

Google's official Gmail MCP server is real and its endpoint is:

    https://gmailmcp.googleapis.com/mcp/v1

Google's published setup is written for Claude and for Antigravity, whose
callbacks are hosted URLs (`https://claude.ai/api/mcp/auth_callback` and
`https://antigravity.google/oauth-callback`). NorthKeep is a local app, so you
register **ours** instead:

1. Google Cloud console → enable the Gmail API on a project.
2. Google Auth Platform → Branding: configure the consent screen.
3. Google Auth Platform → Clients → Create client → **Web application**.
4. Authorized redirect URIs → add exactly:

       http://127.0.0.1:8788/oauth/callback

   This is legal despite being plain http. Google's rule is *"Redirect URIs must
   use the HTTPS scheme, not plain HTTP. Localhost URIs (including localhost IP
   address URIs) are exempt from this rule"*, and likewise for the raw-IP rule.
   That exemption is the one thing this whole design depends on, so **if step 4
   is rejected, stop and tell me** — it means Google changed the rule and the
   callback needs rethinking, not that you did it wrong.
5. Copy the client **id** into the GUI's "Add a remote server" form, and paste
   the client **secret** into the Sign in form.

Endpoint and redirect-URI rule verified against Google's live documentation
today. **What I could not verify is the sign-in itself**, because it needs your
Google account: that is step 3 of the checklist and it is the one place a
surprise would show up.

**Remote servers are macOS-only.** The sign-in lives in the Keychain and there
is no file fallback, deliberately — refresh tokens rotate, and tokens on disk is
not a degradation this product should make quietly.
