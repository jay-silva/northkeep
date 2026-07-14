# NorthKeep Terms of Service

> **DRAFT for attorney review — not yet published, and not legal advice.**
> Bracketed values need confirming before launch: provider legal name, contact
> email, website, effective date. An attorney familiar with open-source
> licensing and SaaS terms should review before you take payment.

**Provider:** Silva Peak Labs, LLC d/b/a NorthKeep ("we," "us"), a Massachusetts
limited liability company.
**Contact:** support@northkeep.ai · **Effective date:** [DATE]

These Terms govern your use of the NorthKeep software and the optional hosted
sync service (together, the "Service"). By installing the software or using the
hosted service, you agree to these Terms.

## 1. The software is open source

The NorthKeep application is licensed under the **GNU Affero General Public
License v3.0 (AGPL-3.0)**, and the memory schema specification under CC-BY-4.0.
Your rights to use, run, study, modify, and redistribute the software are granted
by those licenses — nothing in these Terms restricts them. You may run NorthKeep
locally, and **self-host the sync server, for free.** If the AGPL's obligations
(including its network-use source-sharing requirement) don't fit your
organization, a **separate commercial license** is available — contact
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

## 3. Personal vs. business use

A standard subscription is for an individual's personal use. **Use by a company,
team, or organization — including multi-user or multi-seat deployment — requires
a business/team plan or a commercial license.** Contact support@northkeep.ai to
arrange one. (This section concerns our hosted service and commercial licensing;
it does not limit any rights the AGPL grants you in the software itself.)

## 4. Your account, your keys, no recovery

NorthKeep secures your vault with two secrets: a **passphrase** you choose and a
**device secret** file stored on your machine. **You are solely responsible for
safeguarding both, and for backing up your `device.secret` file.**

**There is no recovery. If you lose your passphrase or device secret, your vault
is permanently inaccessible, and we cannot recover it, reset it, or access your
data for you.** This is a deliberate security property, not a limitation we can
waive. The hosted sync service is **not a backup service** — keep your own
backups of your device secret and, if you wish, your vault file.

## 5. Acceptable use

You agree not to: use the Service for unlawful purposes or to store or transmit
unlawful content; attempt to breach, overload, probe, or circumvent the Service's
security, rate limits, or size limits; resell or provide the hosted service to
third parties without our authorization; or use the Service to infringe others'
rights. We may suspend or terminate access that violates these Terms.

## 6. Disclaimers

The Service is provided **"as is" and "as available," without warranties of any
kind**, express or implied, including merchantability, fitness for a particular
purpose, and non-infringement. NorthKeep is privacy-focused software that reduces
exposure of sensitive data; it does **not** guarantee anonymity, and its
on-device redaction is not perfect (see `KNOWN-LIMITS.md`). NorthKeep is a tool,
not professional advice — it does not provide legal, medical, financial, or other
professional advice, and you are responsible for your own compliance obligations.

## 7. Limitation of liability

To the maximum extent permitted by law, we will not be liable for any indirect,
incidental, special, consequential, or punitive damages, or for lost data,
profits, or goodwill. Our total liability arising out of or relating to the
Service will not exceed the greater of the fees you paid us in the twelve months
before the claim, or **$100 USD**. Some jurisdictions do not allow certain
limitations, so parts of this section may not apply to you.

## 8. Changes and termination

We may modify these Terms or the Service; material changes will be posted at
[website] with an updated effective date, and continued use means acceptance. You
may stop using the Service at any time. We may suspend or terminate the hosted
service for violations of these Terms or to comply with law; you keep your local
vault regardless, since it lives on your device.

## 9. Governing law

These Terms are governed by the laws of the Commonwealth of Massachusetts, USA,
without regard to its conflict-of-laws rules. Disputes will be resolved in the
state or federal courts located in Massachusetts, and you consent to their
jurisdiction. *(Confirm venue/arbitration preference with counsel.)*

## 10. Contact

Questions about these Terms, or to arrange a business or commercial license:
support@northkeep.ai.
