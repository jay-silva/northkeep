# NorthKeep Privacy Policy

> Grounded in how NorthKeep actually handles data (see `KNOWN-LIMITS.md` and
> `SPEC/security-model.md`). Not legal advice.

**Provider:** Silva Peak Labs, LLC d/b/a NorthKeep ("we," "us"), a Massachusetts
limited liability company.
**Contact:** support@northkeep.ai · **Effective date:** July 27, 2026

NorthKeep is built on a simple promise: **your AI memory lives on your device,
encrypted, and we never see its contents** (the exceptions are content you
deliberately choose to share or send: a scope you share with the optional
connector, described below, and the arguments of a tool call you approve,
described in "Tools" below). This policy explains the little data that does
exist, where it lives, and what we do, and don't, do with it. The statements
below describe how NorthKeep works today; if our practices change, we will
update this policy and, for material changes, tell you before the change takes
effect (see "Changes").

## The short version

- The app runs on your machine. Your memories are stored in an **encrypted vault
  on your device**. We cannot read them.
- **No telemetry. No analytics. No tracking.** The app does not phone home: it
  makes no network connection except the ones you initiate or enable: syncing
  your encrypted vault, reaching an AI provider you connect, an update check if
  you turn one on, or — each off by default until you turn it on — a web search
  or fetch you approve, or an MCP server, local or remote, that you connect. We
  do not collect usage data, and there are no third-party trackers in it.
- If you use our **optional hosted sync**, our server stores only an **encrypted
  blob it cannot decrypt** plus a version number, never a key, never plaintext.
- If you **subscribe**, payment is handled by Stripe; your card and email live
  with Stripe, not us. We store only whether your subscription is active.
- **Self-hosting is fully anonymous**, no data reaches us at all.

## What we collect

**On your device (not sent to us):** your memories, their scopes, provenance,
your passphrase, and the credentials NorthKeep stores in your operating
system's keychain — your AI provider API keys, your Brave Search key (if you
enable web search), and any OAuth tokens and client credentials for the remote
MCP servers you connect. None of this is transmitted to us. There is no
account to create to use NorthKeep locally.

**If you enable hosted sync**, our sync server receives and stores:
- an **opaque, client-side-encrypted copy of your vault** (ciphertext bytes we
  cannot decrypt, because we never receive your key), and a version number;
- an **account identifier derived from your device secret** (a one-way hash), so
  your encrypted vault can be matched to your account. It is not linked to your
  name, email, or device unless you subscribe.

**If you subscribe to hosted sync**, to operate billing we additionally store a
mapping between your hashed account identifier and your **Stripe customer and
subscription IDs, subscription status, and current period end.** Your **payment
card and email are collected and held by Stripe**, our payment processor, not by
us. Checkout is Stripe-hosted; card data never touches NorthKeep. See Stripe's
privacy policy at https://stripe.com/privacy. The honest consequence: while a
subscription is active, we can tell *which paying customer is associated with
which encrypted vault*, but never that vault's contents, which remain
ciphertext to us.

## Shared scopes (optional connector)

Everything above describes hosted **sync**, where our server only ever holds
ciphertext and never a key. The optional **connector** is different: it is the
one place your shared memories are briefly decrypted on our server. It exists so
the cloud AI apps you already use (such as Claude or ChatGPT) can reach the
memories you choose.

- **It is off by default and opt-in per scope.** Nothing is shared until you
  explicitly mark a specific scope Shared, after a clear confirmation. A scope you
  keep private is never sent to the connector at all.
- **Shared content is encrypted at rest.** The connector database holds only
  ciphertext of your shared memories, and NorthKeep keeps no key in that database
  that can read them. The key is rebuilt for each request from your connected
  app's own credential plus a secret held on our server. This is not end-to-end
  encryption: to answer each request, the server briefly rebuilds the key and
  decrypts your shared content in memory, and the AI app you connected reads the
  result. The connector is a separate service from the sync server, with its own
  database.
- **The honest limit of that encryption.** Our server can read your shared
  memories, but only for the moment it takes to answer one of your app's
  requests, when it briefly rebuilds the key in memory. The database itself never
  stores that key, so a stolen database is only ciphertext. In short: the stored
  data cannot be read on its own, but the running server can read it while it
  serves your app. Encryption at rest protects against theft of the database or
  its backups, an insider with database-only access, and legal process served
  against the database alone. It does not protect against a compromised or
  malicious running server, which holds the server-side secret and decrypts on
  each request, and so could capture keys and content going forward.
- **What stays visible to us even with content encrypted:** your scope names and
  labels (choose neutral names if a name itself is sensitive), entry identifiers,
  how many memories each shared scope holds, the encrypted sizes (which
  approximate content length), timestamps, and integrity hashes.
- **What we do not derive from it:** no embeddings, no content logs, no analytics.
  We never store your keys, your passphrase, or your device secret on the
  connector.
- **Who else sees it:** any AI app you connect reads whatever it retrieves from
  your shared scopes, under that app's own privacy policy. This is the same
  exposure as connecting a local app, now over the network, and encryption at rest
  does not change it.
- **Deletion:** unshare a scope (or forget a memory) and we delete those rows from
  the connector immediately. Deletion removes exactly what you chose to expose; it
  cannot recall copies an AI app already retrieved.

Self-hosting the connector, or simply never sharing a scope, means no shared
memory ever transits our server.

## What we do not do

- We do **not** collect, read, store, or transmit the contents of your memories
  or conversations, with two exceptions you turn on yourself: (1) a scope you
  deliberately share with the optional connector (see "Shared scopes" above),
  which is stored there encrypted at rest and briefly decrypted per request so
  your own AI apps can read it, and (2) the arguments of a tool call you
  approve — a web search, a web fetch, or a call to an MCP server you've
  connected — which are screened and then masked by our redaction floor before
  they're sent to that destination (see "Tools" below). Everything you keep
  private, and every tool you leave off, stays on your device. (Chat transcripts
  are never stored at all; only distilled memories you can see and undo are
  kept, on your device.)
- We do **not** sell, rent, or share your data with advertisers or data brokers.
- We do **not** run analytics or embed trackers.
- We do **not** create server-side embeddings, logs, or analytics derived from
  your content, the sync server only ever handles ciphertext.

## Data you send to AI providers you choose

NorthKeep can send text to AI models **you** connect:

- In **Chat** mode, your message, after on-device redaction, is sent to the
  model provider you selected (for example a local model on your own machine, or
  a cloud provider using your own API key). When it's a cloud provider, that
  provider receives your redacted text and handles it under **their** privacy
  policy; we are not in that path and do not receive a copy.
- In **Connect** mode, an app you link (such as Claude Desktop) reads memory from
  your vault under the scope you grant and sends whatever you type in that app to
  **its** provider. NorthKeep cannot redact what you type into another app, and
  does not receive that traffic.

You control which providers you use and can disconnect them at any time.

## Tools: web search, web fetch, and MCP servers

NorthKeep can optionally let the model take actions beyond answering from your
vault: searching the web, fetching a page, or calling a tool exposed by an MCP
server you connect. **All of this is off by default.** Turning any of it on
creates data flows to third parties you choose, described here.

### Web search and web fetch

When you enable tools, the model can ask to search the web or fetch a specific
page.

- **Web search.** Your search query is sent to **Brave Search**, a third-party
  search API, authenticated with a key you supply and that NorthKeep stores in
  your operating system's keychain. Brave receives the query text; see Brave's
  own privacy policy for how it handles that.
- **Web fetch.** A URL is requested directly from the site it points to. That
  site receives the URL and whatever a normal web request discloses (for
  example, your IP address), under its own privacy policy.
- **Controls.** Every call is screened on-device for secret shapes, protected
  names, and vault content before it runs. You approve each call at a prompt
  showing the exact query or URL, unless you've granted that specific site
  "always," which you can revoke at any time. Before anything is sent, the
  arguments are passed through a deterministic redaction pass that masks them.
  A per-turn proof shows exactly what left your device. We keep a content-free
  audit log recording that a call happened, not what was in it.
- **The honest limit.** Screening and masking reduce, they do not eliminate,
  what a query or URL can disclose. Using web search or web fetch means
  choosing to send a query or URL to a third party we don't control. **A
  conversation pinned "Private only" does not block web search or web fetch**
  (see the remote MCP servers section below for what "Private only" does
  block).

### MCP servers

You can connect "MCP servers" — programs or services that expose tools to the
model, so it can act beyond your vault (for example, reading your email).
There are two kinds, with different exposure.

- **Local MCP servers** are programs you install and run on your own machine,
  under your own privileges. When you approve a tool call, its arguments —
  masked by NorthKeep's redaction floor first — are passed to that program.
  What that program does with them afterward is outside NorthKeep: many wrap a
  third-party cloud API, and a program forwarding what it's given to that API
  is its own egress, not ours. NorthKeep never sends a local server your vault
  or your conversation, only the approved, masked arguments.
- **Remote MCP servers** are HTTPS services you sign in to, such as a
  provider's own MCP endpoint. Connecting one creates a direct,
  NorthKeep-to-provider data flow:
  - Signing in creates a **standing, scoped OAuth authorization** to your own
    account at that provider. It is not a one-time grant. **We cannot revoke
    it — you revoke it at the provider**, not through NorthKeep. Sign-in
    happens in your browser, at the provider's own authorization page; we
    never see your credentials there.
  - The resulting tokens, and any client credentials you create for that
    connection, are stored only in your operating system's keychain. **We
    never receive them.**
  - The arguments of an approved call — always masked by our redaction floor
    first, with no exception for a server you've marked "trusted" — are sent
    from your device to that provider.
  - Results come back into your conversation and, if you're using a cloud
    model to answer, travel on to that model provider too. Reading data
    through a remote MCP server and then answering with a cloud model means
    **two** third parties see it, not one.
  - **A conversation pinned "Private only" refuses remote MCP tools
    outright.**
  - Each call is approved at a live prompt naming the server and its origin,
    or runs under a standing grant you created at such a prompt and can
    revoke at any time. Only tools you've explicitly marked read-only can hold
    a standing grant; anything else asks every time.
- **What your model provider also learns.** The tool names and descriptions of
  the MCP servers you connect — text written by that server, not by us — are
  included in what we send your model provider, so it knows which tools it can
  call. That means your model provider can learn which services you've
  connected, separately from anything a call's results return.

Self-hosting, or simply never turning tools on or connecting a server, means
none of the data flows in this section happen.

## How we protect the little data we hold

We maintain administrative, technical, and physical safeguards appropriate to the
limited data we hold, including encryption of vault data in transit and at rest,
the design choices described above (no stored keys, data minimization, ciphertext-
only sync), and access controls on our servers. No system is perfectly secure, and
we describe the honest limits of our connector design above and in
`KNOWN-LIMITS.md`.

**Breach notification.** If we discover a security incident that compromises
personal data we hold or the shared content on the connector, we will investigate
promptly and notify affected users, and any regulators, as and when required by
applicable law, for example the Massachusetts data-breach statute (M.G.L.
c. 93H), other U.S. state breach-notification laws, and, for users in the EU or
UK, the GDPR's 72-hour notification rule, without undue delay.

## Data retention and deletion

- **Local data** is under your control, delete your vault, or individual
  memories, on your device at any time.
- **Hosted sync data:** cancel your subscription and request deletion at
  support@northkeep.ai, and we will delete your encrypted vault blob and billing
  mapping. Because the stored blob is ciphertext we cannot read, deletion removes
  bytes we could never interpret in the first place.
- **Consent records:** where we record your consent to subscription auto-renewal,
  we keep that record only as long as needed to show the consent was given, as
  required by applicable automatic-renewal laws, and then delete it.
- Losing your passphrase or your `device.secret` file means the vault is
  **unrecoverable**, by design, there is no back door, which also means we
  cannot access or restore your data for you.

## Your rights

Depending on where you live (for example under GDPR or the CCPA), you may have
rights to access, correct, delete, or export the personal data we hold about you.
In practice we hold very little: a hashed account identifier, and, only if you
subscribe, the Stripe billing mapping described above. To exercise any right, or
to ask what we hold, contact support@northkeep.ai. We do not sell personal
information.

**For users in the EU and UK.** Where the GDPR (or UK GDPR) applies, Silva Peak
Labs, LLC is the **data controller** for the limited account and billing data
described in this policy. Our lawful bases are **performance of a contract** (to
provide the sync and connector features you request) and our **legitimate
interests** in operating, securing, and supporting the Service. You may also have
the right to lodge a complaint with your local supervisory authority. If you
enable the connector, you remain in control of what content you share, and you can
unshare or delete it at any time as described above.

## Children

NorthKeep is not directed to children under 13 (or the minimum age in your
jurisdiction), and we do not knowingly collect their data.

## Changes

We may update this policy. For material changes, we will post the updated policy
at northkeep.ai with a new effective date and, for hosted-service subscribers,
give notice by email or in-app before the change takes effect. Continued use of
the hosted service after a change takes effect means you accept the revised
policy.

## Contact

Questions: support@northkeep.ai.
