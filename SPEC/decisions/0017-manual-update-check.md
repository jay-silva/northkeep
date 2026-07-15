# ADR 0017 — Manual "Check for updates"

- **Date:** 2026-07-15
- **Status:** Accepted
- **Deciders:** Jay (asked for a built-in update check now that real users run
  installed builds), Claude Code

## Context

The desktop app ships with no update mechanism (ADR 0012, Decision 4): the Tauri
auto-updater polls a release endpoint from every user's machine on a schedule,
which is a background phone-home that conflicts with invariant #5 (no telemetry)
and invariant #7 (a networked capability needs an ADR and Jay's OK). ADR 0012
left the door open: "If manual updates prove too painful, we can add a manual
'check for updates' that... compares against the release page."

That point has arrived. Fixes now ship (the GUI feedback batch), and users on an
installed build have no way to learn a newer one exists short of visiting the
site themselves. Stranding people on stale, buggier builds is worse than a
single, honest, user-initiated network call.

## Decision

Add a **manual** update check, reachable at **Settings → About → "Check for
updates."**

1. **User-initiated only.** The check runs solely when the user clicks the
   button. There is no scheduled poll, no on-launch check, no background timer.
   The app still contacts nothing on its own.
2. **A single GET to the public GitHub releases API**
   (`https://api.github.com/repos/jay-silva/northkeep/releases/latest`), made by
   the local Node server, not the page (the page's CSP is `connect-src 'self'`).
   The server compares the `tag_name` against `APP_VERSION` and returns
   `{current, latest, updateAvailable, url}`.
3. **No user data, no telemetry.** The request carries no vault data, no
   identifiers, and no usage information — only the request IP and a static
   `User-Agent: NorthKeep-UpdateCheck`, the same footprint as any HTTP GET. This
   is a version lookup, not analytics. It remains consistent with invariant #5.
4. **Downloads and installs nothing.** When an update exists, the UI shows the
   new version and a Download button that opens the GitHub release page in the
   user's browser (via `/api/open`, ADR none — reuses the link opener). The user
   downloads and installs the DMG themselves. No self-modifying code.
5. **The About panel always shows the running version**, so the check is not
   required just to answer "what am I on?"

`APP_VERSION` lives as a constant in `apps/web/src/api.ts`. **Release checklist:
bump `APP_VERSION` to match `apps/desktop/src-tauri/tauri.conf.json` on every
release,** or the check misreports. It is a constant (not read from a
package.json) to avoid bundle-path fragility; the drift risk is a UX
mis-report, never a security issue.

## Alternatives considered

- **Tauri signed auto-updater** (background poll + download + install,
  Ed25519-signed). Smoothest UX and cryptographically safe, but it is the
  background phone-home ADR 0012 declined, plus self-modifying code — too large a
  trust departure for a privacy brand to enable by default. Left as possible
  future work behind its own ADR + adversarial review, opt-in only.
- **Automatic on-launch version check** (one GET per launch). Better nudging,
  but it reintroduces an outbound connection the user didn't ask for on every
  start. Deferred; the manual button is the strict-privacy baseline. If adopted
  later it should be opt-out and disclosed.
- **Stay fully manual (status quo).** Rejected: users don't discover fixes.

## Consequences

- The only outbound hosts the app ever contacts remain: the model provider the
  user explicitly selected, the user's own sync server, and now — only on an
  explicit click — the public GitHub releases API. All three are disclosed.
- KNOWN-LIMITS.md updated: still no auto-update / no background polling / no
  auto-install; there is now a manual, opt-in check.
- The Privacy Policy should note the manual update check as an outbound call the
  user triggers (follow-up, not code).
- Rate limits: GitHub's unauthenticated API allows 60 requests/hour per IP —
  ample for a manual button; on a 403/limit the check reports a friendly "could
  not reach the update service."
