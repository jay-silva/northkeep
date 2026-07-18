# NorthKeep Terms of Service

> Not legal advice.

**Provider:** Silva Peak Labs, LLC d/b/a NorthKeep ("we," "us"), a Massachusetts
limited liability company.
**Contact:** support@northkeep.ai · **Effective date:** July 17, 2026

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

**Corresponding source for our hosted service.** When we operate a modified
version of NorthKeep as a network service (our hosted sync and connector
servers), AGPL-3.0 section 13 entitles users interacting with that service to the
Corresponding Source of the exact version we run. We publish that source,
including our modifications, at https://github.com/silvapeak/northkeep, and you
may also request it at support@northkeep.ai.

**Contributions.** Contributions to NorthKeep are accepted under the Developer
Certificate of Origin and our contributor terms, under which contributors license
their contributions to us on terms that permit both the AGPL release and the
separate commercial license described above. If you contribute, you confirm you
have the right to do so; if you have not agreed to those terms, please do not
submit contributions.

## 2. The hosted sync service

We offer an optional hosted sync service so your encrypted vault can move between
your devices.

- **Price:** $10.00 USD per month, billed through Stripe. Subscriptions renew
  automatically each month until cancelled.
- **Your consent to automatic renewal.** Before your first charge, we present the
  automatic-renewal terms (that your subscription continues and renews until you
  cancel, the recurring price, the billing frequency, and how to cancel) clearly
  and conspicuously at checkout, and we begin billing only after you give express
  affirmative consent to those terms. We keep a record of that consent.
- **Renewal reminders.** We send you a confirmation when you subscribe and, for
  any subscription that continues for a year or more, at least one renewal
  reminder per year. Each reminder states that the subscription auto-renews, the
  amount and frequency of the charge, and clear instructions for cancelling.
- **Cancellation:** cancel anytime, using the same online channel you used to
  subscribe, via `northkeep sync billing` (the Stripe billing portal) or by
  emailing support@northkeep.ai. Cancellation is effective without any retention
  step or fee. Access continues until the end of the paid period; we do not
  provide prorated refunds for partial periods except where required by law.
- **Price changes.** If we change the subscription price, we will give you advance
  notice by email to the address associated with your subscription before the new
  price takes effect. The new price applies only to renewals after that notice,
  and you may cancel before it takes effect.
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
  your app's request. This is **not end-to-end encryption**, and it is a guarantee
  about the stored data, not a promise that content is never decrypted in
  operation. Scope names, entry identifiers, counts, encrypted sizes, and
  timestamps remain visible to the server. See the Privacy Policy for the full
  description.
- **Your responsibility for what you share.** You are responsible for the content
  you choose to share and for having the right to share it. Do not share content
  you are not permitted to place on a third-party server, and do not use the
  connector to store or transmit unlawful content.
- **We do not scan your shared content.** We do not analyze, mine, index for
  advertising, train models on, or derive analytics from the memories you share.
  The server decrypts them only to serve them back to the apps you connect. This
  describes how the connector works today; if that ever changes, we will update
  these Terms and the Privacy Policy and tell you before the change takes effect.
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
waive. **The hosted sync service is not a backup service** and does not protect
you against a lost passphrase or device secret: keep your own backups of your
device secret and, if you wish, your vault file. We remind you of this when you
subscribe and in the app so that the choice to rely on it is an informed one.

## 6. Acceptable use

You agree not to: use the Service for unlawful purposes or to store or transmit
unlawful content; attempt to breach, overload, probe, or circumvent the Service's
security, rate limits, or size limits; resell or provide the hosted service to
third parties without our authorization; or use the Service to infringe others'
rights. We may suspend or terminate access that violates these Terms.

## 7. Disclaimers

The Service is provided **"as is" and "as available," without warranties of any
kind**, express or implied, including merchantability, fitness for a particular
purpose, and non-infringement, **except for those warranties that cannot be
disclaimed under applicable law.** NorthKeep is privacy-focused software that
reduces exposure of sensitive data; it does **not** guarantee anonymity, and its
on-device redaction is not perfect (see `KNOWN-LIMITS.md`). NorthKeep is a tool,
not professional advice, it does not provide legal, medical, financial, or other
professional advice, and you are responsible for your own compliance obligations.

## 8. Limitation of liability

To the maximum extent permitted by law, we will not be liable for any indirect,
incidental, special, consequential, or punitive damages, or for lost data,
profits, or goodwill. Our total liability arising out of or relating to the
Service will not exceed the greater of the fees you paid us in the twelve months
before the claim, or **$100 USD**.

**Nothing in these Terms excludes or limits liability that cannot be excluded or
limited under applicable law**, including liability for gross negligence,
willful misconduct, or fraud, and any non-waivable rights or remedies you have
under consumer-protection statutes (such as the Massachusetts Consumer Protection
Act, M.G.L. c. 93A, where it applies). Some jurisdictions do not allow certain
limitations, so parts of this section may not apply to you.

## 9. Changes and termination

We may modify these Terms or the Service. **For material changes, we will give
reasonable advance notice before they take effect**: for hosted-service
subscribers, by email to the address associated with your subscription or through
an in-app notice; for others, by posting the updated Terms at northkeep.ai with a
new effective date. Continued use of the Service after the effective date means
acceptance; if you do not agree to a material change, you may stop using the
Service, and hosted subscribers may cancel, before it takes effect. We may suspend
or terminate the hosted service for violations of these Terms or to comply with
law; you keep your local vault regardless, since it lives on your device.

## 10. Governing law and disputes

These Terms are governed by the laws of the Commonwealth of Massachusetts, USA,
without regard to its conflict-of-laws rules.

**Talk to us first.** Before starting a lawsuit, you agree to contact us at
support@northkeep.ai with a brief description of the dispute and to give us
**30 days** to try to resolve it informally. Most issues can be resolved this way,
and this step is a condition to filing suit (it does not shorten any deadline the
law gives you, and does not apply where advance notice would forfeit a legal
right).

If the dispute is not resolved, it will be brought in the state or federal courts
located in Massachusetts, and you consent to their jurisdiction. **We have not
required arbitration or waived your right to participate in a class action**;
you keep those rights.

## 11. Contact

Questions about these Terms, or to arrange a business or commercial license:
support@northkeep.ai.
