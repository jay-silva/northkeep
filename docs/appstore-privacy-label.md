# App Store "App Privacy" nutrition label: answers for Jay to enter

> This is a Jay-enters-in-App-Store-Connect checklist, not code. It maps
> NorthKeep's actual data handling (see `legal/PRIVACY.md`, `KNOWN-LIMITS.md`,
> CLAUDE.md invariants #1, #2 and #5) to the App Store Connect "App Privacy"
> questionnaire. It covers the iPhone app only (build 27, version 0.22.0). Four
> items are judgment calls, flagged for counsel below; item 3 (Cloud Connect)
> now carries a recommendation. Not legal advice.

## The honest baseline

NorthKeep collects **no telemetry, no analytics, no tracking, no usage or
diagnostic data**. The iPhone app has no analytics, crash-reporting, ad or
push SDKs and no over-the-air update client (`apps/mobile/package.json`,
`apps/mobile/app.config.ts` plugins). The data that can reach NorthKeep's
servers from the phone is:

- (a) the client-side-encrypted vault blob, sent to the sync server the user
  sets up (default `https://northkeep-sync-server.vercel.app`,
  `apps/mobile/src/lib/sync-setup-flow.ts:29`), which also stores a version
  number, the blob's size and SHA-256, and when it last changed
  (`apps/sync-server/src/neon-storage.ts:19-26`);
- (b) a bearer token derived one-way from the device secret; the sync server
  stores only its SHA-256 (`packages/sync/src/creds.ts:36-44`,
  `apps/sync-server/src/handler.ts:79`);
- (c) if the user shares a scope with Cloud Connect (Settings, Cloud Connect),
  that scope's memories, sent in plaintext over TLS and encrypted by the
  connector for storage, stored there until unshared, and decrypted briefly on
  the server to answer each request from the user's connected AI apps
  (`packages/sync/src/connector-client.ts:128-146`,
  `apps/connector-server/src/create-server.ts:602-607`). Scope names, entry
  ids, sizes, timestamps and whether a row was app-written stay plaintext. The
  connector account is keyed on the SHA-256 of a second device-secret-derived
  token (`packages/sync/src/creds.ts:52-57`,
  `apps/connector-server/src/create-server.ts:313`).

Separately, and not to NorthKeep: a Converse message, with the memories
retrieved for it, after on-device redaction, goes directly to the AI provider
the user configured with their own key; on an Apple Intelligence device,
Converse can run on the phone with no network call
(`packages/platform-mobile/src/local-model/apple-fm.ts`). This build has no
in-app purchase, so the app itself creates no billing record; the app never
touches card or email data (Stripe-hosted checkout happens off-app on
desktop/web).

## Start here: is there ANY collection in the reviewed build?

Yes. Settings lets the user set a sync server URL, and the app pushes and pulls
the encrypted vault. Settings also opens Cloud Connect, which uploads any scope
the user shares and downloads memories the user's connected AI apps wrote. So
you **cannot** select the blanket "Data Not Collected" for the whole app.

## Answer table (enter exactly this)

Apple's test for "collected": transmitted off the device in a way that lets
the developer (or a partner) access it for longer than needed to service the
request in real time. "Linked" means tied to an identity or account
identifier. Every row not marked Yes is "Not Collected".

| App Store data type | Collected? | Linked to user? | Used for tracking? | Purpose | Why (code evidence) |
|---|---|---|---|---|---|
| **User Content: Other User Content** | **Yes** | **Yes** | No | App Functionality | Sync blob (stored ciphertext, keyed on the account hash) and Cloud Connect shared scopes (stored, server can decrypt, keyed on the connector account hash). See judgment calls 1 and 3. |
| **Identifiers: User ID** | **Yes** | **Yes** | No | App Functionality | The sync account hash (`sync_blobs.token_hash`) and the connector account hash (`connector_accounts.account_hash`); each routes the user's data to their account. |
| Identifiers: Device ID | No | | | | The device secret is a random value the user can move between devices, not a hardware or advertising identifier; only hashes of tokens derived from it leave the phone. |
| User Content: Customer Support | No (see judgment call 4) | | | | The sync-access screen opens a `mailto:` draft in the user's own mail app with the account id in the body (`apps/mobile/src/lib/sync-support-mail.ts`); the app transmits nothing itself. |
| User Content: Emails or Text Messages, Photos or Videos, Audio Data, Gameplay Content | No | | | | The camera only scans the Mac's link QR code; nothing is stored or sent. |
| Contact Info (Name, Email, Phone, Physical Address, Other) | No | | | | No account for local use; no sign-up in the app. |
| Financial Info (Payment, Credit, Other) | No | | | | Card and email are entered on Stripe-hosted checkout off-app; the app has no purchase flow. See judgment call 2. |
| Purchases: Purchase History | No | | | | No in-app purchase; the Stripe billing mapping is created by desktop/web checkout, not by this app. |
| Health & Fitness | No | | | | |
| Location (Precise, Coarse) | No | | | | No location API is used. |
| Sensitive Info | No | | | | NorthKeep does not ask for it. Anything a user types into a memory is covered by Other User Content. |
| Contacts | No | | | | |
| Browsing History, Search History | No | | | | The iPhone app has no web search or web fetch. |
| Usage Data (Product Interaction, Advertising Data, Other) | No | | | | No analytics. The connector's request log records reads made by the user's connected AI apps, not the iPhone app's own use; see judgment call 3. |
| Diagnostics (Crash, Performance, Other) | No | | | | No crash or performance reporting (invariant #5). |
| Surroundings, Body | No | | | | |
| Other Data Types | No | | | | |

### Tracking

- Does the app track users across apps or websites owned by other companies?
  **No.**
- No third-party SDKs, no ad identifiers, no ATT prompt needed.

## Judgment calls to confirm with counsel

1. **Is client-side-encrypted content "collected"?** Apple's definition covers
   data transmitted off-device and stored beyond a transient request. The vault
   blob is stored server-side, so the conservative, honest answer is to
   disclose it as User Content, even though it is opaque ciphertext NorthKeep
   cannot read. Because Cloud Connect content (item 3) must be disclosed as
   Other User Content anyway, this question no longer changes the answer
   table; it only affects how the sync blob is described.
2. **Financial Info via Stripe.** Because checkout is Stripe-hosted and off-app,
   marking Financial Info "Not Collected by the app" and naming Stripe as
   processor in the privacy policy is defensible and matches `legal/PRIVACY.md`.
   Confirm this is how counsel wants it presented.
3. **Cloud Connect shared scopes. Recommendation: disclose, as entered in the
   table (Other User Content: Collected Yes, Linked Yes, Tracking No, App
   Functionality; plus the connector account hash under User ID).**
   Reasoning:
   - Apple's test is storage beyond real-time servicing plus developer access.
     Shared rows are stored on NorthKeep's connector until the user unshares
     them, and the running server can decrypt them to answer each request
     (`apps/connector-server/src/crypto.ts`), so NorthKeep can access the
     content. That meets the test more clearly than the sync blob does; the
     "we cannot read it" argument from item 1 is not available here.
   - It is linked: every row is keyed on the connector account hash, a
     persistent account identifier. The conservative reading of Apple's
     definition treats data tied to a User ID as linked even when the ID is
     pseudonymous; counsel may confirm.
   - It is not tracking: it is not combined with third-party data or shared
     with data brokers. The user's own connected AI apps read it at the user's
     direction, under those apps' own policies.
   - Purpose is App Functionality only: the connector serves the user's own AI
     apps and derives nothing from content (invariant #2).
   - The label cannot express "encrypted at rest but decryptable per request";
     the privacy policy carries that detail ("Shared scopes"), which is why the
     policy and this label must be updated together.
   - Not selecting it is the only option that could be wrong. Over-disclosing
     a category the app only uses when the user opts in costs little; the
     Other User Content row is already Yes because of sync.
   - Open for counsel: whether the connector's request log (tool, time, entry
     ids returned by a connected AI app) is "Usage Data". The recommendation
     is No, because it records third-party apps' reads rather than the iPhone
     app's own use, but counsel may prefer Other Usage Data, Linked, App
     Functionality.
4. **The support email.** The sync-access screen opens an email draft to
   support@northkeep.ai containing the user's sync account id; the user sends
   it from their own mail app. Recommendation: Not Collected by the app, since
   the app transmits nothing and the user chooses to send it. The privacy
   policy now discloses it ("Email you send us"). If counsel prefers the
   conservative answer, enter Customer Support: Collected Yes, Linked Yes,
   Tracking No, App Functionality.

## Consistency check

These answers must agree with `legal/PRIVACY.md` and the privacy policy URL
you enter in App Store Connect (`site/privacy.html` is the published copy and
must say the same thing). As of the 0.22.0 legal redlines, the policy describes
the iPhone app, the iPhone Keychain, sync, Cloud Connect uploads and
downloads, and the support email; publish that version before submitting. If
the app later adds in-app purchase, analytics, web tools or any other network
path, this label must be revised before that build ships.
