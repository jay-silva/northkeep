# App Store "App Privacy" nutrition label: answers for Jay to enter

> This is a Jay-enters-in-App-Store-Connect checklist, not code. It maps
> NorthKeep's actual data handling (see `legal/PRIVACY.md`, `KNOWN-LIMITS.md`,
> CLAUDE.md invariant #5) to the App Store Connect "App Privacy" questionnaire.
> Two items are genuine judgment calls, flagged for counsel. Not legal advice.

## The honest baseline

NorthKeep collects **no telemetry, no analytics, no tracking, no usage or
diagnostic data**. The only data that ever leaves the device is (a) the
end-to-end-encrypted vault blob and a version number, sent to a sync server the
user configures, and (b) a one-way hashed account identifier used to match that
blob to the user's sync account. This build has no in-app purchase, so the app
itself creates no billing record; the app never touches card or email data
(Stripe-hosted checkout happens off-app on desktop/web).

## Start here: is there ANY sync in the reviewed build?

Yes. Settings lets the user set a sync server URL, and the app pushes/pulls the
encrypted vault. So you **cannot** select the blanket "Data Not Collected" for
the whole app. You must disclose the sync data honestly, as below.

## Per-category answers to enter

For each App Store Connect data type, the answer is "Not Collected" unless listed
as collected below.

### Collected

**User Content: "Other User Content" (the encrypted vault blob)**
- Collected: **Yes** (only if/when the user turns on sync).
- Linked to the user's identity: **Yes** (it is tied to the hashed sync account
  identifier). It is not linked to name/email unless the user separately
  subscribes off-app.
- Used for tracking: **No.**
- Purpose: **App Functionality** only.
- Note to add: the content is client-side encrypted; the server stores ciphertext
  it cannot decrypt. (See the counsel flag below on whether encrypted content is
  "collected" at all.)

**Identifiers: "User ID" (the hashed account identifier)**
- Collected: **Yes** (only with sync on).
- Linked to identity: **Yes** (it is the account key).
- Used for tracking: **No.**
- Purpose: **App Functionality** (routes the encrypted blob to the right account).

**Purchases: subscription status** *(only if this build ever exposes sync
subscription state; in the current build it does not, see the flag).*
- Current build: **do not select.** The app has no in-app purchase and creates no
  billing record. The Stripe billing mapping lives server-side and is created by
  desktop/web checkout, not by this app.

### Not Collected (select "Data Not Collected" / do not add)

- **Financial Info**: Not collected by the app. Card and email are entered on
  Stripe-hosted checkout off-app; card data never touches NorthKeep. Name Stripe
  as the processor in the review notes / privacy policy, not in the app label.
- **Contact Info** (name, email, phone, address): Not collected. No account for
  local use.
- **Health & Fitness**: Not collected.
- **Location** (precise or coarse): Not collected.
- **Contacts**: Not collected.
- **Browsing History / Search History**: Not collected.
- **Usage Data** (product interaction, ads): Not collected. No analytics.
- **Diagnostics** (crash, performance): Not collected. (Crash reporting would be
  opt-in and content-free per invariant #5, and is not enabled.)
- **Sensitive Info**: Not collected.
- **Purchases**: Not collected by the app (see above).
- **Search History, Audio Data, Gameplay Content, Customer Support, Other Data
  Types**: Not collected.

### Tracking

- Does the app track users across apps/websites owned by other companies? **No.**
- No third-party SDKs, no ad identifiers, no ATT prompt needed.

## Two judgment calls to confirm with counsel

1. **Is client-side-encrypted content "collected"?** Apple's definition covers
   data transmitted off-device and stored beyond a transient request. The vault
   blob is stored server-side, so the conservative, honest answer is to disclose
   it as User Content (as above), even though it is opaque ciphertext NorthKeep
   cannot read. This is the recommended default. Counsel may prefer different
   framing, but do not silently omit it.
2. **Financial Info via Stripe.** Because checkout is Stripe-hosted and off-app,
   marking Financial Info "Not Collected by the app" and naming Stripe as
   processor is defensible and matches `legal/PRIVACY.md`. Confirm this is how
   counsel wants it presented.

## Consistency check

These answers must agree with `legal/PRIVACY.md` and the privacy policy URL you
enter in App Store Connect. They do as written. If the app later adds in-app
purchase or any analytics, this label must be revised before that build ships.
