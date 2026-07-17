# NorthKeep: App Store review notes

> Reviewer-facing. Paste the relevant parts into the "Notes" field in App Store
> Connect (App Review Information). The demo API key, if used, goes ONLY in that
> field, never in this file or the public repo. See the note flagged for Jay at
> the end.

## What NorthKeep is

NorthKeep is a local-first, encrypted memory vault for AI. Your notes and
memories are stored in an encrypted database on the device itself. There is no
NorthKeep account and no login required to use the app locally. Nothing is
readable until you unlock the vault with a passphrase you choose on the device.
The app does not phone home, contains no analytics or tracking, and collects no
personal data (see the App Privacy answers).

Because everything is encrypted at rest and gated behind a vault, a reviewer who
just installs the app sees a locked/empty state, not the product. Two paths let
you see the full app with no Mac and no account:

## Fastest path: tap "Try a demo"

On the first screen (Onboarding), under "Just looking?", tap **"Try a demo"**.
This instantly opens a synthetic sample vault with made-up memories so you can
see how a populated vault looks. It requires no passphrase, no account, and no
setup, and nothing leaves the device. A banner marks it clearly as a demo, and
it is torn down when you leave the screen.

The demo is read-only by design (it illustrates a populated vault). To exercise
the create-vault, unlock, and Converse (AI chat) flows, use the next path.

## Full path: create a vault and try the AI chat (Converse)

1. On the first screen, tap **"Start fresh on this phone"**.
2. Choose any passphrase (for review, something simple is fine). The app then
   derives your encryption keys on the device.
   - **Please allow 1 to 2 minutes here.** Key derivation (Argon2id at strong
     settings) runs on the device and is intentionally slow; the app is working,
     not frozen. The same wait happens on the first unlock.
3. You now have a real (empty) local vault. You can add a memory, browse
   memories, and open Settings.
4. To try the AI chat, open the **Chat** tab (Converse) and tap **Providers**.
   Add a provider by pasting an AI API key (this is "bring your own key"; the key
   is stored only in the iOS keychain on the device and is never sent to
   NorthKeep). Then return to Chat and send a message.
   - See the flagged note below about whether a demo key is supplied for review.

## How Converse (the AI chat) works, and why it is safe to review

- Converse is "bring your own key" (BYOK). The user connects an AI model of their
  choice (for example Anthropic or OpenAI) with their own API key. NorthKeep is
  not an AI provider and ships no built-in model in this build.
- Before any message is sent, NorthKeep runs an on-device redaction pass that
  masks secrets (emails, phone numbers, SSNs, card numbers, IP addresses, API
  keys) out of the outbound text. A persistent banner states plainly that only
  this Tier-1 masking is active on the phone. A "What left this device" view
  shows the exact text that was sent.
- The AI conversation is private to the user and stays on the device (plus the
  chosen provider). It is not shared with other users and there is no social or
  public feed. This is not user-generated content in the social sense.

## No account, no in-app purchase

- There is no account or login to use NorthKeep locally.
- This build has **no in-app purchase**. The optional hosted sync subscription is
  arranged outside the app (on the desktop app / web via Stripe-hosted checkout).
  In the app, Settings only lets a user point at a sync server URL; it does not
  sell anything.

## Permissions the app requests

- **Camera**: only to scan the link code shown by NorthKeep on a Mac, to link a
  phone to an existing desktop vault. No photos are taken or stored. (Not needed
  for the demo or the "Start fresh" path.)
- **Face ID**: optional, to unlock the vault with a key held on the device.

## Encryption / export compliance

NorthKeep is publicly available open-source software (AGPL-3.0,
github.com/jay-silva/northkeep) that uses only standard published cryptography
via libsodium. `ITSAppUsesNonExemptEncryption` is set to false on the
open-source exemption basis.

---

## Flag for Jay (decide before submitting): demo Converse key

Converse needs a working API key to return a reply. The demo vault is read-only
and does not exercise Converse, so a reviewer cannot see the AI chat produce a
response without a key. Options:

1. **Provision a throwaway BYOK key for the reviewer (recommended).** Create a
   low-spend, rate-capped API key (for example a small Anthropic key with a hard
   monthly cap), and paste it, plus a one-line "paste this in Providers" step,
   into the App Store Connect review-notes field ONLY. Do not commit it. Revoke
   it after review. This lets the reviewer see Converse end to end.
2. **No key; describe Converse instead.** Tell the reviewer Converse is BYOK and
   that, without a key, the flow is visible up to the "Add a provider" step. This
   is honest and lower-effort, but the reviewer cannot see a live AI reply, which
   can invite questions on an AI app.

Whichever you choose, keep the key out of the repository and out of this file.
