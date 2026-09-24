# NorthKeep Privacy Policy

**Provider:** Silva Peak Labs, LLC d/b/a NorthKeep ("we," "us"), a Massachusetts
limited liability company.
**Contact:** support@northkeep.ai · **Effective date:** 2026-09-XX

NorthKeep is built on a simple promise: **your AI memory lives on your device,
encrypted, and we never see its contents** (the exceptions are content you
deliberately choose to share or send: a scope you share with the optional
connector, or a project one of your connected apps creates there, described
below, and the arguments of a tool call you approve,
described in "Tools" below). This policy explains the little data that does
exist, where it lives, and what we do, and don't, do with it. It covers the
NorthKeep app for Mac, the NorthKeep app for iPhone, our optional hosted sync
and connector services, and the northkeep.ai website. The statements below
describe how NorthKeep works today; if our practices change, we will update
this policy and, for material changes, tell you before the change takes effect
(see "Changes").

## The short version

- The app runs on your Mac or iPhone. Your memories are stored in an
  **encrypted vault on your device**. We cannot read them.
- **No telemetry. No analytics. No tracking.** The app does not phone home: it
  makes no network connection except the ones you initiate or enable: syncing
  your encrypted vault, sharing a scope with the connector, reaching an AI
  provider you connect, or, on the Mac, a local model download you click
  (performed by Ollama), an update check when you click "Check for updates,"
  or (each off by default until you turn it on) a web search or fetch you
  approve, or an MCP server, local or remote, that you connect. We do not collect usage data, and there are no
  third-party trackers in it.
- If you use our **optional hosted sync**, our server stores an **encrypted
  blob it cannot decrypt** plus the bookkeeping needed to serve it (a version
  number, its size, a checksum, and when it last changed), never a key, never
  plaintext.
- If you **subscribe**, payment is handled by Stripe; your card and email live
  with Stripe, not us. We store your Stripe customer and subscription IDs, your
  subscription's status, and its current period end, linked to your hashed
  account identifier.
- **Self-hosting is fully anonymous**, no data reaches us at all.

## What we collect

**On your device (not sent to us):** your memories, their scopes, provenance,
your passphrase, and the credentials NorthKeep stores in your device's
keychain. On a Mac, that is the **macOS Keychain**, which holds your AI
provider API keys, your Brave Search key (if you enable web search), and any
OAuth tokens and client credentials for the remote MCP servers you connect. On
an iPhone, that is the **iOS Keychain**, which holds your device secret, your
AI provider API keys, your sync and connector settings, and, if you turn on
Face ID unlock, a copy of your vault key that the Keychain releases only after
Face ID succeeds. (On a platform
without a Keychain, API keys fall back to an environment variable you supply,
and remote MCP sign-in is not available at all.) On an iPhone, the encrypted
vault file can be included in your device or iCloud backup like other app
data; it remains encrypted there. If you turn on the optional
local project mirror on a Mac, NorthKeep also writes your project documents as
plain, unencrypted text files into a folder you choose and records them with
git on your Mac; NorthKeep never pushes that folder anywhere. When you run a
memory review on a Mac, NorthKeep keeps review records as unencrypted files in
its own folder on your Mac so you can undo a change; they can still contain
reviewed text after you forget a memory. None of this is
transmitted to us. There is no account to create to use NorthKeep locally.

**If you enable hosted sync**, our sync server receives and stores:
- an **opaque, client-side-encrypted copy of your vault** (ciphertext bytes we
  cannot decrypt, because we never receive your key; the file's short
  unencrypted header holds only the non-secret settings needed to decrypt it),
  together with a version number, its size, a checksum of the ciphertext, and
  the time it last changed;
- an **account identifier derived from your device secret** (a one-way hash,
  of which our server stores only a further hash), so your encrypted vault can
  be matched to your account. It is not linked to your name, email, or device
  unless you subscribe, or you send it to us yourself (see "Email you send
  us").

**If you subscribe to hosted sync**, to operate billing we additionally store a
mapping between your hashed account identifier and your **Stripe customer and
subscription IDs, subscription status, and current period end,** and the time
that record last changed. We pass your hashed account identifier to Stripe as
the checkout reference, so the subscription can be matched to your account.
Your **payment card and email are collected and held by Stripe**, our payment
processor, not by us. Checkout is Stripe-hosted; card data never touches
NorthKeep. See Stripe's privacy policy at https://stripe.com/privacy. The honest
consequence: while a subscription is active, we can tell *which paying customer
is associated with which encrypted vault*, but never that vault's contents,
which remain ciphertext to us. The billing record stays after a subscription
ends, marked as ended, until you ask us to delete it.

## Website waitlist (optional)

If you submit the waitlist form on northkeep.ai, your email address is
delivered to our inbox at support@northkeep.ai by **Resend**, our email
delivery provider. We use it only to send NorthKeep updates. It is not added
to any marketing list. We delete it on request to the same address. The form
sets no cookies and the site has no analytics. See Resend's privacy policy at
https://resend.com/legal/privacy-policy.

## Email you send us

If you write to support@northkeep.ai, we receive your email address and what
you write, and use them only to answer you. When you ask for sync access, the
iPhone app can open an email to us that contains your sync account identifier;
if you send it, we can associate that identifier with your email address.

## Shared scopes (optional connector)

Everything above describes hosted **sync**, where our server only ever holds
ciphertext and never a key. The optional **connector** is different: it is the
one place your shared memories are briefly decrypted on our server. It exists so
the cloud AI apps you already use (such as Claude or ChatGPT) can reach the
memories you choose. You can use it from the Mac app and from the iPhone app
(Settings, Cloud Connect).

- **It is off by default and opt-in per scope.** Nothing is shared until you
  explicitly mark a specific scope Shared, after a clear confirmation, with one
  exception: a new project that one of your connected apps creates (see
  "Connected apps can write" below). A scope you keep private is never sent to
  the connector at all.
- **Shared content is encrypted at rest.** The connector database holds only
  ciphertext of your shared memories, and NorthKeep keeps no key in that database
  that can read them. The key is rebuilt for each request from the credential of
  the app or device making the request plus a secret held on our server. This is
  not end-to-end encryption: your device sends shared content to the connector
  over an encrypted connection and the connector encrypts it for storage; to
  answer each request, the server briefly rebuilds the key and decrypts your
  shared content in memory, and the AI app you connected reads the result. The
  connector is a separate service from the sync server, with its own database.
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
- **Connected apps can write.** An AI app you connect can save new memories
  into a scope you have shared, and can create a new project. What an app writes
  is stored on the connector, encrypted at rest like everything else there, is
  readable by every app you have connected, and is downloaded into your vault
  when your Mac or iPhone syncs with the connector. When an app creates a
  project that does not yet exist on your device, your device marks that
  project Shared without a separate confirmation and adds the project document;
  from then on it is an ordinary shared scope, shown as Shared, that you can
  unshare.
- **What stays visible to us even with content encrypted:** your scope names
  (choose neutral names if a name itself is sensitive; a project that an app
  creates is named by that app), entry identifiers, whether each entry was
  written by your device or by a connected app and whether it is still waiting
  to be downloaded to your device, how many memories each shared scope holds,
  the encrypted sizes (which approximate content length), timestamps, and the
  integrity hash your device computes for each entry it shares. We also keep:
  for each AI app you connect, the registration details that app sends when it
  connects (such as its name and the address it returns to after sign-in) and
  which account it is linked to; while an app is signing in, and until we clean
  them up, one-time sign-in records that link that app to your account, with
  its return address, a sign-in check value, and an expiry time; a request log
  for your account, recording each request your connected apps make (the tool
  used, the time, how many results, and the identifiers of the entries
  returned, never their content) and each time your own Mac or iPhone uploads
  shared scopes, unshares a scope, or confirms a download (the action, the time,
  and how many entries or scopes, never their names or content); the name of
  each scope you unshare and when; and the date through which your account may
  use the connector.
- **What we do not derive from it:** no embeddings, no content logs, no analytics.
  We never store your keys, your passphrase, or your device secret on the
  connector.
- **Who else sees it:** any AI app you connect reads whatever it retrieves from
  your shared scopes, under that app's own privacy policy. This is the same
  exposure as connecting a local app, now over the network, and encryption at rest
  does not change it.
- **Deletion:** unshare a scope and we delete its rows from the connector
  immediately, whether or not your subscription is active. Forget a memory on
  your device and it is deleted from the connector the next time that device
  syncs with it; a memory an app forgets is deleted once your device next
  syncs. **After your subscription ends, that second path stops:** the
  connector refuses your device's syncs, so a memory you forget on your device,
  or that an app forgot before the subscription ended, stays on the connector
  until you unshare its scope or subscribe again. To remove shared content after
  a subscription ends, unshare the scope. Deletion removes exactly what you
  chose to expose; it cannot recall copies an AI app already retrieved. The
  records listed above (unshared scope names, the request log, and connected-app
  registrations) remain until you ask us to delete them, as does anything an
  app writes that your device holds back without adding (for example, into a
  project that already exists on your device but is not shared).

Self-hosting the connector, or simply never sharing a scope and never
connecting an app to it, means no shared memory ever transits our server.

## What we do not do

- We do **not** collect, read, store, or transmit the contents of your memories
  or conversations, with two exceptions you turn on yourself: (1) a scope you
  deliberately share with the optional connector, or a project one of your
  connected apps creates there (see "Shared scopes" above),
  which is stored there encrypted at rest and briefly decrypted per request so
  your own AI apps can read it, and (2) the arguments of a tool call you
  approve (a web search, a web fetch, or a call to an MCP server you've
  connected), which are screened and masked by our redaction floor before
  they're sent to that destination, except for a local server that is marked
  "trusted," such as NorthKeep's own vault server, whose arguments stay on your
  machine (see "Tools" below). Everything you keep private, and every tool
  you leave off, stays on your device, apart from what you send to an AI
  provider you choose (see "Data you send to AI providers you choose" below).
  (Chat transcripts are never stored at
  all; only distilled memories you can see and undo are kept, on your device.)
- We do **not** sell, rent, or share your data with advertisers or data brokers.
- We do **not** run analytics or embed trackers.
- We do **not** create server-side embeddings, logs, or analytics derived from
  your content, the sync server only ever handles ciphertext.

## Data you send to AI providers you choose

NorthKeep can send text to AI models **you** connect:

- In **Chat** mode, your message, the earlier turns of that conversation, the
  text of any file you attach, and the memories retrieved to answer it, after
  on-device redaction, are sent to the model provider you
  selected (for example a local model on your own machine, or a cloud provider
  using your own API key). When it's a cloud provider, that provider receives
  your redacted text and handles it under **their** privacy policy; we are not
  in that path and do not receive a copy. Redaction can be turned off only for
  a model at a private network address (your own machine or a private
  network), never for a cloud provider. On
  an iPhone with
  Apple Intelligence, you can instead chat with the model built into the phone,
  which runs on the device. After a cloud chat on an iPhone, the "What left
  this device" view shows the exact text sent to the provider on the most
  recent turn.
- **Memory review on a cloud model (Mac, optional).** Memory review runs on a
  local model by default. If you choose a cloud provider for a review instead,
  you pick a redaction tier (1, 2 or 3; redaction cannot be turned off for a
  review) and confirm the send on the screen that names the provider. The text
  of the memories being compared is then masked on your Mac at that tier, as in
  Chat, and sent to that provider under its privacy policy. If Tier 2's local
  name model is unavailable, nothing is sent; if Tier 3's is unavailable, the
  review continues with the other Tier 3 masking only. Some details still
  leave as written: each memory's identifier and type; the name of its scope,
  with only the identifiers Tier 1 masks (and, at Tier 3, dates) removed from
  it, so a person's name in a scope name is sent; and the time NorthKeep
  recorded the memory, exactly at Tiers 1 and 2 and as the year only at
  Tier 3.
- In **Connect** mode, an app you link (such as Claude Desktop) reads memory from
  your vault under the scope you grant and sends whatever you type in that app to
  **its** provider. NorthKeep cannot redact what you type into another app, and
  does not receive that traffic.

You control which providers you use and can disconnect them at any time.

## Tools: web search, web fetch, and MCP servers

The NorthKeep app for Mac can optionally let the model take actions beyond
answering from your vault: searching the web, fetching a page, or calling a tool
exposed by an MCP server you connect. The iPhone app has none of these tools.
**All of this is off by default.** Turning any of it on creates data flows to
third parties you choose, described here.

### Web search and web fetch

When you enable tools, the model can ask to search the web or fetch a specific
page.

- **Web search.** Your search query is sent to **Brave Search**, a third-party
  search API, authenticated with a key you supply and that NorthKeep stores in
  the macOS Keychain. Brave receives the query text; see Brave's own privacy
  and API terms for how it handles that (Brave's published API privacy notice
  states it does not collect identifiers linking a query to an individual and
  retains query logs for a maximum of 90 days, for billing and
  troubleshooting).
- **Web fetch.** A URL is requested directly from the site it points to. That
  site receives the URL and whatever a normal web request discloses (for
  example, your IP address), under its own privacy policy.
- **Controls.** Every call is screened on-device for secret shapes, protected
  names, and vault content before it runs. You approve each call at a prompt
  showing the exact query or URL, unless you've granted that specific site
  "always," which you can revoke at any time. Before anything is sent, the
  arguments are passed through a deterministic redaction pass that masks them.
  In NorthKeep's command-line chat on the Mac, each reply names the redaction
  tier it ran at and lists the tool calls it made, and each call to an MCP
  server shows the masked arguments it sent. We keep a content-free audit log recording that
  a call happened, not what was in it.
- **The honest limit.** Screening and masking reduce, they do not eliminate,
  what a query or URL can disclose. Using web search or web fetch means
  choosing to send a query or URL to a third party we don't control. **A
  conversation pinned "Private only" does not block web search or web fetch**
  (see the remote MCP servers section below for what "Private only" does
  block).

### MCP servers

You can connect "MCP servers": programs or services that expose tools to the
model, so it can act beyond your vault (for example, reading your email).
There are two kinds, with different exposure.

- **Local MCP servers** are programs you install and run on your own machine,
  under your own privileges. When you approve a tool call, its arguments are
  masked by NorthKeep's redaction floor first and then passed to that program,
  unless the server is marked "trusted," in which case they are passed
  unmasked. NorthKeep's own vault server is marked trusted when you add it from
  NorthKeep's list (or confirm that an existing entry is it), because it saves
  what you ask it to remember into your vault on this machine and sends
  nothing anywhere; any other local server is trusted only if you mark it so
  in its configuration file. What that program does with them
  afterward is outside NorthKeep: many wrap a third-party cloud API, and a
  program forwarding what it's given to that API is its own egress, not ours.
  NorthKeep never sends a local server your vault or your conversation, only
  the approved arguments.
- **Remote MCP servers** are HTTPS services you sign in to, such as a
  provider's own MCP endpoint. Connecting one creates a direct,
  NorthKeep-to-provider data flow:
  - Signing in creates a **standing, scoped OAuth authorization** to your own
    account at that provider. It is not a one-time grant. **We cannot revoke
    it; you revoke it at the provider**, not through NorthKeep. Sign-in
    happens in your browser, at the provider's own authorization page; we
    never see your credentials there.
  - The resulting tokens, and any client credentials you create for that
    connection, are stored only in the macOS Keychain. **We never receive
    them.**
  - The arguments of an approved call, always masked by our redaction floor
    first (a remote server can never be marked "trusted"), are sent from your
    device to that provider.
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
  the MCP servers you connect (text written by that server, not by us) are
  included in what we send your model provider, so it knows which tools it can
  call. That means your model provider can learn which services you've
  connected, separately from anything a call's results return.

Self-hosting, or simply never turning tools on or connecting a server, means
none of the data flows in this section happen.

## How we protect the little data we hold

We maintain administrative, technical, and physical safeguards appropriate to the
limited data we hold, including encryption of vault data in transit and at rest,
the design choices described above (no stored keys, data minimization,
ciphertext-only sync), and access controls on our servers. No system is perfectly secure, and
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
- **Connector data:** unshare scopes as described above, or request deletion at
  support@northkeep.ai, and we will delete your shared content and the connector
  records linked to your account.
- **Consent records:** where we record your consent to subscription auto-renewal,
  we keep that record only as long as needed to show the consent was given, as
  required by applicable automatic-renewal laws, and then delete it.
- Losing your passphrase or your `device.secret` file means the vault is
  **unrecoverable**, by design, there is no back door, which also means we
  cannot access or restore your data for you.

## Your rights

Depending on where you live (for example under GDPR or the CCPA), you may have
rights to access, correct, delete, or export the personal data we hold about you.
In practice we hold very little: a hashed account identifier; only if you
subscribe, the Stripe billing mapping described above; only if you use the
connector, your shared content and the connector records described above; and
any email you send us or submit through the waitlist form. To exercise any
right, or to ask what we hold, contact support@northkeep.ai. We do not sell
personal information.

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
