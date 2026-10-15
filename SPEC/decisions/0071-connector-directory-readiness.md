# ADR 0071: Connector directory hosts and client metadata documents

Status: Accepted 2026-10-15 · Review: code review below, against the files named there

## Context
A directory listing needs a stable host, tool hints, and a client that can name itself with an https URL.

## Decision
- D1: Accepted origins are https://mcp.northkeep.ai, the Vercel host, PUBLIC_URL, and PUBLIC_URL_ALIASES. Discovery uses the request host only when it is on that list. Anything else falls back to PUBLIC_URL. A token is valid for any of those origins' /mcp resources. A refresh or code exchange that names a different one is refused. DNS and the Vercel domain are outside this repo.
- D2: tools/list sets readOnlyHint, destructiveHint, idempotentHint, and openWorldHint. Hints do not change handlers. Six tools are read-only. memory_forget is destructive and idempotent. The other three are writes, not destructive and not idempotent. openWorldHint is false on all of them.
- D3: An https client_id that is not already registered is fetched as a client metadata document. Port 443 only. No credentials, fragment, private, loopback, link-local, or shared address. Redirects are not followed. The cap is 16 KiB and the document is not stored. The address is checked before the connection, so a later change of address can still be reached. The consent page shows the client id. A name with a control or hidden-direction character is refused.
- D4: `pnpm seed:reviewer` writes four fictional rows, ids starting with sample-, on the account of the supplied token only, and only when that account has no other rows. The pairing code lasts seven days, is single-use, and goes to a mode 0600 file outside the repo. It is not printed.

## Consequences
Old connections keep working. DNS is manual. A self-hosted server also accepts the two public hosts as audiences. The page shows the address because the name is the app's words.

## Rejected
Dropping the Vercel host would stop tokens already issued for it. Connecting to the checked address would fail TLS for honest clients. Printing the reviewer code would put it in a log.

## What leaves the machine
Discovery text, and a new outbound GET of the client metadata URL the app names. That request carries no vault content and no credential. Tool arguments are unchanged. The seed writes only to the database the operator names.

## Review
Checked 2026-10-15 against public-origin.ts, create-server.ts, provider.ts, cimd.ts, consent.ts, mcp.ts, and reviewer-seed.ts. Tried a spoofed Host, a foreign resource, private DNS, a redirect, a secret in the document, a hidden-direction name, and a seed that would touch another row. The page escapes the name and the id. A refresh keeps the issued audience. One wound, fixed here: the page had shown only the app's name. Nothing else found. The address-check gap remains, and KNOWN-LIMITS states it.

## Links
Extends ADRs 0019, 0020, 0033, 0040, and 0061.
