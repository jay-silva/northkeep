# Navigation revision acceptance

This revision uses the approved navigation-preview layout with the original app's fonts and palette. It is part of the current curation milestone, not a release or a vault migration.

Use the synthetic sample described in [consolidation-acceptance.md](consolidation-acceptance.md). Do not use your real vault for test writes or enable real sharing or desktop connections in this sample.

## Check the revised interface

1. Unlock the sample. Memories opens without a chat screen. The main navigation offers Memories, Review, Connect, and Settings.
2. Browse collections inside Memories. Writing and the sample project collection remain visible. Select each collection and All memories. Search and type filters still work.
3. Add a synthetic memory, edit its wording, move it to another collection, and forget it. Check that counts and selections stay current after each action. These actions must affect only the sample.
4. Click Connect. Desktop and Cloud appear; opening the group alone must not connect an app or share a collection. Collapse it again and try the same control with a keyboard.
5. Open Desktop, Cloud, and each Settings page. The old app's typography and colors should be consistent with Memories and Review. Existing connection and sharing confirmations remain in place.
6. Open Review from a collection. Check its selected collection, inspect a suggestion, preview the exact wording, cancel, then confirm once. Restore through Change history. Detailed memory review remains reachable.
7. Repeat at 390px width. Collection selection, navigation, Add memory, and review actions must fit without horizontal page overflow. Check light and dark appearance.
8. Export the sample. Removing the chat destination must not remove stored memories, imported conversation provenance, or memory history.

## Scope

No stored vault data is deleted by this navigation revision. It does not remove legacy command-line packages or import support. It does not change the vault schema, encryption, sharing policy, or model consent.

Implementation verification and owner acceptance are separate. The owner accepted the completed local functionality and visual revision on 2026-09-10. A passing sample and local acceptance do not authorize deployment.

## Local verification, 2026-09-10

Owner approval: “implement,” with the approved navigation layout and original fonts/colors. Rules version: 2026-09-07.1. Source and tests were integrated without overwriting pre-existing work.

The isolated full suite passed 1,543 tests with one existing skip across 118 files. Focused UI checks passed 38 tests. Eight HTTP curation/consolidation tests passed, the web TypeScript build passed, and the inline script parses. Original font-face blocks and root theme tokens are byte-identical to the pre-revision baseline.

Synthetic browser checks exercised collection browsing, Add, Edit, Move, Connect disclosure, Settings/Models, and guided suggestions. An independent visual reviewer returned SHIP for the supplied dark-theme desktop and 390px captures only. At that point, light-theme visual verification and owner acceptance remained pending. Final collection-routing race fixes had regression coverage and an independent code-review verdict; they were not recaptured in that browser pass.

No new network route was added. Existing session-token and vault-unlock gates remain unchanged. This revision does not change vault storage, encryption, import/export formats, connection permissions, or deployment state. The design detector ran once in degraded regex mode; it could not evaluate computed contrast and reported pre-existing warning-border and prose findings.

Use the Silva Peak Chrome profile for the acceptance check. Previously opened sample servers may still serve an earlier in-memory copy of the page; restart the sample to load the final files.

## Preview parity pass, 2026-09-10

Owner confirmed the workflow works and requested the approved preview’s visual polish. Updated the actual application: sidebar icons, vault summary, two-line collection rows, subtle selection, larger Newsreader memory text, compact type filtering, and quieter Edit/More actions. Original font definitions and root theme tokens remain unchanged. Memories now uses the preview’s existing stronger light secondary-text color; collection privacy labels come from actual sharing status and remain unknown when unavailable.

Verification: 41 focused UI tests and 8 isolated HTTP tests passed; web/core/librarian builds passed. Independent source review cleared the fixes. Desktop and 390px renders were inspected in dark and forced-light sample copies, with no horizontal overflow. Light CSS was forced only in the disposable test copy because native browser theme emulation was unavailable; automatic OS theme switching was not verified. Edit and More targets measured 44 by 44px. Browser checks exercised nested collection selection, type filtering, keyword search, Add, Edit/save, Move/save, Connect keyboard disclosure, collection-to-guided-review routing, suggestions, exact confirmation preview, focus wrap, and Escape focus return. HTTP tests covered apply/history/restore.

Forget reached its confirmation, but automatic approval review rejected confirming the permanent deletion of the synthetic memory. The memory remained at that point; this browser check was incomplete. Export and every Settings page were not repeated in this pass. No deployment, real-vault test writes, or vault-format changes. Mechanical design scan ran in degraded regex mode and reported existing warning-border/prose findings; it did not assess computed contrast. This paragraph records the earlier preview-parity evidence; the owner subsequently accepted the completed local functionality and visual revision on 2026-09-10.

Follow-up: owner authorized “can delete the synthetic test memory.” Browser confirmation timed out, so the existing local sample API removed only the identified session-created memory. Readback verified its absence and the count changed from 13 to 12. The deletion outcome is verified; browser confirmation completion remains unverified.

## Accepted milestone closeout, 2026-09-10

The owner accepted M1/M2 locally. Final isolated regression: 1,546 passed, one existing skip across 118 files. The report-schema tests now create and clean their own temporary home rather than depending on an externally supplied directory; independent review cleared this test-isolation fix. Missing dependency links were repaired only in the disposable checkout. Eight HTTP checks and 41 focused UI checks passed during the polish pass.

Browser verification covered Settings destinations Import, Models, Activity, Tools, Sync and About without changing connections. A metadata-only sample export check found 15 entries, including three historical entries and 12 active entries, with provenance present throughout. The authorized synthetic deletion was already verified. Automatic OS theme switching and completion of the browser delete-confirmation animation remain unverified; forced-light and dark rendering were inspected. No deployment or real-vault writes were performed.
