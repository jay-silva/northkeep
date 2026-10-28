# Design record for ADR 0083: policy accuracy

Each changed published claim, the wording it now has, and the code it rests on. Line numbers are in `legal/*.md`; `site/*.html` carries the same text.

## Terms

| Claim (after) | Source |
|---|---|
| "You subscribe on a checkout page hosted by Stripe. Before you pay, that page shows the monthly price and states that your subscription renews automatically each month at that price until you cancel, and that you can cancel at any time in the billing portal." (:40) | `apps/sync-server/src/billing.ts` `custom_text.submit.message`; `apps/sync-server/test/checkout-session.test.ts` |
| Contributions: "you confirm you have the right to do so. We may ask you to agree to separate terms before we accept a contribution." (:29) | No CONTRIBUTING, CLA or DCO file exists; git authors are the founder, Claude and dependabot |
| "the Privacy Policy describes them" (:85), was "lists all of it" | Privacy lists now read "such as" |
| "We remind you of this in the app" (:163), was "when you subscribe and in the app" | The subscribe card (`apps/web/static/index.html`) shows no backup reminder; onboarding backup prompts exist |
| "Not legal advice." removed (:3) | Drafting note that rendered on the public page |

## Privacy

| Claim (after) | Source |
|---|---|
| Update check "asks GitHub, where we publish releases, for the latest version" (:28) | `apps/web/src/api.ts` calls `api.github.com` on click |
| "If you self-host and point every NorthKeep app you use at your own servers, no account data reaches us. The iPhone app is set to our hosted servers until you change it." (:40) | `apps/mobile` sync setup pre-fills the hosted URL; vault session falls back to the hosted connector |
| Connector records include "the address of the sync server you use, version and sequence numbers, the identifiers of entries an app has forgotten that your device has not yet removed, and one-time codes used to check your subscription" (:188) | `apps/connector-server/src/neon-storage.ts` columns `vault_server`, `vault_version`, `scope_seq`, `pending_forgets`, `entitlement_nonces` |
| "Pointing every app at a connector you host yourself, or never sharing a scope…" (:214) | Same defaults as :40 |
| "Never turning tools on or connecting a server means none…" (:367), dropped "Self-hosting" | Self-hosting does not stop Brave or MCP traffic |
| Breach: "notify affected users without undue delay where applicable law requires it, and notify regulators where the law requires that" (:379) | GDPR Art. 33 (regulator, 72 hours) and Art. 34 (users, without undue delay) are separate duties |
| "In practice we hold very little, such as:" | The old list omitted the encrypted vault |

## Not changed, and why

- The Cloudflare hosting sentence: the founder is checking the DNS proxy status for `mcp.` and `sync.`.
- Renewal reminders, "without any retention step", access until the end of the paid period, and the price-change email: these depend on Stripe dashboard settings, and the server holds no email addresses.
- Notice-of-change clauses: every edit narrows a promise or adds a disclosure, so none is treated as a material change against users.
