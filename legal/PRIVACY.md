# NorthKeep Privacy Policy

> Grounded in how NorthKeep actually handles data (see `KNOWN-LIMITS.md` and
> `SPEC/security-model.md`). Not legal advice.

**Provider:** Silva Peak Labs, LLC d/b/a NorthKeep ("we," "us"), a Massachusetts
limited liability company.
**Contact:** support@northkeep.ai · **Effective date:** July 14, 2026

NorthKeep is built on a simple promise: **your AI memory lives on your device,
encrypted, and we never see its contents** (the one exception is a scope you
deliberately choose to share with the optional connector, described below: those
shared memories are stored on our server encrypted at rest, the connector
database holds no key that can read them, and the key is rebuilt for each request
from your app's own credential plus a secret held on our server, which briefly
decrypts them in memory so a connected AI app can read the result). This policy
explains the little data that does exist, where it lives, and what we do, and
don't, do with it.

## The short version

- The app runs on your machine. Your memories are stored in an **encrypted vault
  on your device**. We cannot read them.
- **No telemetry. No analytics. No tracking.** The app does not phone home. We do
  not collect usage data, and there are no third-party trackers in it.
- If you use our **optional hosted sync**, our server stores only an **encrypted
  blob it cannot decrypt** plus a version number, never a key, never plaintext.
- If you **subscribe**, payment is handled by Stripe; your card and email live
  with Stripe, not us. We store only whether your subscription is active.
- **Self-hosting is fully anonymous**, no data reaches us at all.

## What we collect

**On your device (not sent to us):** your memories, their scopes, provenance,
your passphrase, and your API keys (kept in your operating system's keychain).
None of this is transmitted to us. There is no account to create to use NorthKeep
locally.

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
  or conversations, with one exception you turn on yourself: a scope you
  deliberately share with the optional connector (see "Shared scopes" above),
  which is stored there encrypted at rest and briefly decrypted per request so
  your own AI apps can read it. Everything you keep private stays on your device.
  (Chat transcripts are never stored at all; only distilled memories you can see
  and undo are kept, on your device.)
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

## Data retention and deletion

- **Local data** is under your control, delete your vault, or individual
  memories, on your device at any time.
- **Hosted sync data:** cancel your subscription and request deletion at
  support@northkeep.ai, and we will delete your encrypted vault blob and billing
  mapping. Because the stored blob is ciphertext we cannot read, deletion removes
  bytes we could never interpret in the first place.
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

## Children

NorthKeep is not directed to children under 13 (or the minimum age in your
jurisdiction), and we do not knowingly collect their data.

## Changes

We may update this policy; material changes will be posted at northkeep.ai with an
updated effective date. Continued use of the hosted service after a change means
you accept the revised policy.

## Contact

Questions: support@northkeep.ai.
