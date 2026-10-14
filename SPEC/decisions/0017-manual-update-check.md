# ADR 0017: Manual "Check for updates"

Status: Accepted 2026-07-15 · Review: none recorded

## Context
The desktop app ships with no update mechanism (ADR 0012, Decision 4): a scheduled auto-updater poll is a background phone-home that conflicts with invariants #5 and #7. Fixes now ship, and users on installed builds have no way to learn a newer one exists short of visiting the site. ADR 0012 left room for a manual check against the release page.

## Decision
- D1: A manual check at Settings → About → "Check for updates". It runs only when the user clicks: no scheduled poll, no on-launch check, no background timer.
- D2: One GET to `https://api.github.com/repos/jay-silva/northkeep/releases/latest`, made by the local Node server (the page's CSP is `connect-src 'self'`). The server compares `tag_name` to `APP_VERSION` and returns `{current, latest, updateAvailable, url}`.
- D3: The request carries no vault data, no identifiers and no usage information; only the request IP and a static `User-Agent: NorthKeep-UpdateCheck`.
- D4: It downloads and installs nothing. A Download button opens the GitHub release page in the browser via `/api/open`; the user installs the DMG.
- D5: The About panel always shows the running version.
- D6: `APP_VERSION` is a constant in `apps/web/src/api.ts`. Release checklist: bump it to match `apps/desktop/src-tauri/tauri.conf.json` every release, or the check misreports (a UX error, never a security issue).

## Consequences
- Easier: users can find fixes without leaving the app.
- Harder: `APP_VERSION` must be bumped by hand each release.
- Limits: GitHub's unauthenticated API allows 60 requests/hour per IP; on a 403 or limit the check reports "could not reach the update service". KNOWN-LIMITS.md still says no auto-update, no background polling, no auto-install. The Privacy Policy should note this user-triggered call (follow-up, not code).

## Rejected
- Tauri signed auto-updater: the background phone-home ADR 0012 declined, plus self-modifying code; possible future work, opt-in only, behind its own ADR and adversarial review.
- On-launch check: an outbound connection the user did not ask for on every start; deferred, and if adopted it should be opt-out and disclosed.
- Staying fully manual: users do not discover fixes.

## What leaves the machine
The original has no egress section. It states: only on an explicit click, one GET to the public GitHub releases API, carrying the request IP and a static User-Agent, no vault data, identifiers or usage information. When written, this made the app's outbound hosts the user-selected model provider, the user's own sync server, and this check; later ADRs add others.

## Links
Extends: ADR 0012 (Decision 4) · Full record: docs/design/adr-0017-manual-update-check.md
