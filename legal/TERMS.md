# NorthKeep Terms of Service

> Not legal advice.

**Provider:** Silva Peak Labs, LLC d/b/a NorthKeep ("we," "us"), a Massachusetts
limited liability company.
**Contact:** support@northkeep.ai · **Effective date:** July 14, 2026

These Terms govern your use of the NorthKeep software and the optional hosted
sync service (together, the "Service"). By installing the software or using the
hosted service, you agree to these Terms.

## 1. The software is open source

The NorthKeep application is licensed under the **GNU Affero General Public
License v3.0 (AGPL-3.0)**, and the memory schema specification under CC-BY-4.0.
Your rights to use, run, study, modify, and redistribute the software are granted
by those licenses, nothing in these Terms restricts them. You may run NorthKeep
locally, and **self-host the sync server, for free.** If the AGPL's obligations
(including its network-use source-sharing requirement) don't fit your
organization, a **separate commercial license** is available, contact
support@northkeep.ai.

## 2. The hosted sync service

We offer an optional hosted sync service so your encrypted vault can move between
your devices.

- **Price:** $10.00 USD per month, billed through Stripe. Subscriptions renew
  automatically until cancelled.
- **Cancellation:** cancel anytime via `northkeep sync billing` (the Stripe
  billing portal). Access continues until the end of the paid period; we do not
  provide prorated refunds for partial periods except where required by law.
- **What it stores:** an encrypted copy of your vault that we cannot decrypt, and
  a subscription record. See the Privacy Policy.
- **Free alternative:** you can self-host the sync server at no charge instead.

## 3. Shared scopes (optional connector)

We offer an optional **connector** that copies scopes **you explicitly choose to
share** to a NorthKeep connector server so the AI apps you connect can reach
them. It is part of the hosted subscription.

- **Opt-in and reversible.** Sharing is off by default and happens per scope, only
  after you confirm. You can unshare a scope at any time, which deletes its content
  from the connector server (this cannot recall copies an app already retrieved).
- **Encrypted at rest, decrypted per request.** The connector database stores your
  shared content as ciphertext, and NorthKeep keeps no key in that database that
  can read it; the key is rebuilt for each request from your connected app's own
  credential plus a secret held on our server. So a stolen database is only
  ciphertext, but the running server can read your shared content while it serves
  your app's request. This is a guarantee about the stored data, not a promise
  that content is never decrypted in operation. Scope names, entry identifiers,
  counts, encrypted sizes, and timestamps remain visible to the server. See the
  Privacy Policy for the full description.
- **Your responsibility for what you share.** You are responsible for the content
  you choose to share and for having the right to share it. Do not share content
  you are not permitted to place on a third-party server, and do not use the
  connector to store or transmit unlawful content.
- **We do not scan your shared content, ever.** We do not analyze, mine, index for
  advertising, train models on, or derive analytics from the memories you share.
  The server decrypts them only to serve them back to the apps you connect.
- **Takedown on notice.** If we receive a valid legal notice, or a report that
  shared content is unlawful, we may remove or disable access to the specific
  content or suspend the connector for the affected account. We act on notice; we
  do not proactively monitor or scan shared content.
- **Same exposure as connecting an app.** Any AI provider you connect receives
  whatever it retrieves from your shared scopes, under its own terms. Private
  scopes are never sent.

## 4. Personal vs. business use

A standard subscription is for an individual's personal use. **Use by a company,
team, or organization, including multi-user or multi-seat deployment, requires
a business/team plan or a commercial license.** Contact support@northkeep.ai to
arrange one. (This section concerns our hosted service and commercial licensing;
it does not limit any rights the AGPL grants you in the software itself.)

## 5. Your account, your keys, no recovery

NorthKeep secures your vault with two secrets: a **passphrase** you choose and a
**device secret** file stored on your machine. **You are solely responsible for
safeguarding both, and for backing up your `device.secret` file.**

**There is no recovery. If you lose your passphrase or device secret, your vault
is permanently inaccessible, and we cannot recover it, reset it, or access your
data for you.** This is a deliberate security property, not a limitation we can
waive. The hosted sync service is **not a backup service**, keep your own
backups of your device secret and, if you wish, your vault file.

## 6. Acceptable use

You agree not to: use the Service for unlawful purposes or to store or transmit
unlawful content; attempt to breach, overload, probe, or circumvent the Service's
security, rate limits, or size limits; resell or provide the hosted service to
third parties without our authorization; or use the Service to infringe others'
rights. We may suspend or terminate access that violates these Terms.

## 7. Disclaimers

The Service is provided **"as is" and "as available," without warranties of any
kind**, express or implied, including merchantability, fitness for a particular
purpose, and non-infringement. NorthKeep is privacy-focused software that reduces
exposure of sensitive data; it does **not** guarantee anonymity, and its
on-device redaction is not perfect (see `KNOWN-LIMITS.md`). NorthKeep is a tool,
not professional advice, it does not provide legal, medical, financial, or other
professional advice, and you are responsible for your own compliance obligations.

## 8. Limitation of liability

To the maximum extent permitted by law, we will not be liable for any indirect,
incidental, special, consequential, or punitive damages, or for lost data,
profits, or goodwill. Our total liability arising out of or relating to the
Service will not exceed the greater of the fees you paid us in the twelve months
before the claim, or **$100 USD**. Some jurisdictions do not allow certain
limitations, so parts of this section may not apply to you.

## 9. Changes and termination

We may modify these Terms or the Service; material changes will be posted at
northkeep.ai with an updated effective date, and continued use means acceptance. You
may stop using the Service at any time. We may suspend or terminate the hosted
service for violations of these Terms or to comply with law; you keep your local
vault regardless, since it lives on your device.

## 10. Governing law

These Terms are governed by the laws of the Commonwealth of Massachusetts, USA,
without regard to its conflict-of-laws rules. Disputes will be resolved in the
state or federal courts located in Massachusetts, and you consent to their
jurisdiction.

## 11. Contact

Questions about these Terms, or to arrange a business or commercial license:
support@northkeep.ai.
