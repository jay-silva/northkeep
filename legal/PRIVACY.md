# NorthKeep Privacy Policy

> **DRAFT for attorney review, not yet published, and not legal advice.**
> Grounded in how NorthKeep actually handles data (see `KNOWN-LIMITS.md` and
> `SPEC/security-model.md`). Bracketed values need confirming before launch:
> provider legal name, contact email, website, effective date.

**Provider:** Silva Peak Labs, LLC d/b/a NorthKeep ("we," "us"), a Massachusetts
limited liability company.
**Contact:** support@northkeep.ai · **Effective date:** [DATE]

NorthKeep is built on a simple promise: **your AI memory lives on your device,
encrypted, and we never see its contents.** This policy explains the little data
that does exist, where it lives, and what we do, and don't, do with it.

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

## What we do not do

- We do **not** collect, read, store, or transmit the contents of your memories
  or conversations. (Chat transcripts are never stored at all; only distilled
  memories you can see and undo are kept, on your device.)
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

We may update this policy; material changes will be posted at [website] with an
updated effective date. Continued use of the hosted service after a change means
you accept the revised policy.

## Contact

Questions: support@northkeep.ai.
