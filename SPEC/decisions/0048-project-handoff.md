# ADR 0048: revision-bound local project handoffs

Status: implemented locally after adversarial clearance; owner application accepted. Owner approved the Projects mock and selected Codex to Claude Desktop as the first handoff pair. Rules 2026-09-07.1.

## Decision

Build the approved Projects surface and a local handoff contract on existing encrypted working memories. Both selected assistants can use the local MCP server. This milestone establishes correctness against one local vault under its existing file lock; whole-vault sync and the hosted connector retain their existing conflict semantics and must not be described as coordinated multi-writer storage.

The local Projects API and new MCP resume/checkpoint/wrap tools return the project document, parsed sections, exact current entry ID as revision, history and file references. Every new handoff write requires the revision read and a unique operation ID. Compare within the same locked vault callback as mutation and one save. Duplicate live working documents refuse with a conflict. Existing local project_update accepts an expected revision and requires it when changing an existing document; creation remains explicit. List uses valid project slugs only. Generic memory editing is still a user-controlled low-level path; it creates a new revision and makes an outstanding handoff stale.

Checkpoint and wrap contain authored status, next actions, completed work, optional decisions/open questions and file references. No model runs in these paths. Review displays exact authored values and source revision before confirmation. Omitted fields preserve existing sections; an explicit empty next-actions section is allowed. Preserve additional Markdown sections. Log rollover and the updated head must be saved atomically in one vault transaction; a failed save closes the dirty handle. Durable receipts live in hash-covered metadata on the result entry and bind the operation ID to the project, base revision, mode and exact request bytes. Exact retries return the original receipt even after later updates; altered reuse refuses. Forgetting a receipt removes that retry guarantee and must be documented. Never silently recreate an operation after an identifiable invalid receipt.

File references are descriptive data, not instructions or automatic file/URL access. Accept bounded labels and locators, with type local_path, url or memory and caller-reported access. Display caller-reported verification as such with date/context, never as an independent server check. Resume reports all unchecked references as unverified for the receiving assistant. There is no automatic URL fetch, file open, attachment upload or new sharing action. New routes use the existing session-token and unlocked-vault gates; local MCP uses existing grants. Render all document and error text as text, not HTML. No dependency or encryption/schema changes.

## Boundaries and acceptance

The UI inherits the approved layout, colors and fonts. It offers project selection, summary, next action, decisions/questions, files and secondary history, then resume/review/checkpoint/wrap with truthful local-save receipts. Stale writes show the current state without replacing the user's draft. Lock/navigation invalidate pending responses. At 390px controls fit, type is at least 11px and targets at least 44px; dialogs trap focus and close on Escape.

Test exact retries/restarts, changed operation reuse, stale writes with zero mutation, duplicate heads, wrong scope/grant, malformed metadata, explicit empty next actions, log rollover failure, save failure, preserved extras, untrusted markup and inaccessible references. Test two distinct MCP clients against a session-created vault, then exercise the real Codex-to-Claude Desktop handoff without production test writes or silently modifying assistant configuration. If connecting the second client needs configuration approval, prepare the exact change after the implementation and tests are complete.

Hosted parity, distributed concurrent writes and live hosted-sync certification remain separate work. The UI must say saved on this device, not synced or delivered to another assistant. Existing hosted tools are not changed by this ADR. No production deployment is authorized.

## Review record

### 2026-09-10 pre-implementation adversarial review

**Verdict: HOLD until the mandatory patches below are incorporated.** Review was
read-only and code-grounded against `packages/core/src/vault.ts` and
`project-doc.ts`, `packages/mcp-server/src/server.ts` and the file lock,
`apps/web/src/session.ts`, the existing sync save hook/down-sync path, and the
hosted connector boundary. Rules version 2026-09-07.1 was loaded from the
authoritative Mac file. No vault, connector, browser, or project tool was used.

1. **Hash the canonical validated request, not transport bytes.** MCP handlers do
   not receive the original JSON bytes, and equivalent JSON can differ by key
   order and whitespace. Define one canonical request object after validation,
   exclude `operation_id`, preserve string bytes without Unicode normalization,
   and hash its canonical UTF-8 serialization with an existing crypto primitive.
   Persist that request hash and the exact normalized authored fields needed for
   the receipt. A retry with the same operation ID and hash returns the original
   result; any different hash refuses.

2. **Use a reserved, authenticated metadata shape and a dedicated core
   primitive.** `Vault.editMemory` copies the prior entry's metadata unchanged,
   so it cannot safely create a handoff receipt. Pin a reserved metadata key,
   strict field/length validation, `result_id === entry.id`, project/scope/base
   revision/mode/request-hash checks, and lineage checks comparable to the
   existing consolidation operation validation. Search retries across live and
   superseded entries. Copied, malformed, ambiguous, forgotten, or identifiable
   but invalid receipt metadata must fail closed; do not create a replacement
   operation.

3. **Make creation and conflicts exact.** Creation must send
   `expected_revision: null`; updating must send the full current entry ID.
   Under the acquired file lock, find all live working heads in the exact valid
   project scope. Zero heads permits only explicit creation, one head must equal
   the expected revision, and more than one head is a conflict. Every refusal is
   mutation-free. `project_list` must use `parseProjectSlug`, because the current
   local helper uses the weaker prefix-only `isProjectScope` test.

4. **Pin the document mapping.** The current pure merge supports status, next
   actions, one decision and one log entry; it has no completed-work, open-
   questions, or file-reference representation. Specify which fields replace,
   append, or preserve which headings, their deterministic Markdown format and
   bounds, and how structured values round-trip. An explicit empty next-actions
   value must remain distinguishable from omission; the current MCP schema's
   `min(1)` rejects it. Duplicate known headings must be rejected or resolved by
   a stated deterministic rule before a write.

5. **Make the save bundle one core operation.** Existing `remember` and
   `editMemory` mutate the in-memory SQLite image, while only `save()` persists
   the encrypted file. The new core method must own the receipt lookup,
   head/revision check, archive creation, updated head and receipt metadata in
   one SQLite transaction; the host then calls one `save()`. If the method or
   save throws, the host closes the dirty vault without another save. Do not
   emit a success audit or receipt before save succeeds. Keep this callback
   synchronous and bounded: the shared file lock can be stolen on age after 60
   seconds even if its process is alive.

6. **Apply return redaction to the entire new project shape.** Existing local
   project tools return raw project content even when
   `NORTHKEEP_REDACT_TIER=1`; the current `maskContent` helper only covers flat
   `{content}` values. Resume, list, stale-conflict state, history, decisions,
   questions, file labels/locators and any content-derived error detail must be
   masked recursively before MCP return. Revision IDs, operation IDs, booleans
   and timestamps remain exact. Never feed a masked returned document back into
   the local merge or store it as the project head. Add seeded secret/name tests
   for every nested field and both success and stale responses.

7. **State the local/sync boundary precisely.** The proof is two clients against
   one Mac vault and its lock. A successful save is durable locally and the tool
   does not wait for or certify delivery to another client. The existing save
   listener may still schedule auto-sync, and a scope already marked Shared may
   leave the machine through that previously approved path. Return the existing
   `shared` state as context, but do not claim hosted parity, delivery, or
   distributed conflict safety. The hosted connector tools and down-sync
   last-writer behavior remain unchanged.

8. **Keep files descriptive and provenance-qualified.** The proposed
   `ProjectView` shape is suitable if file `access` means caller-reported state,
   `checked_at` is required when access is `reported`, all locators are bounded,
   and resume resets unchecked receiving-client references to `unverified`.
   No handler may stat, open, fetch, upload, or follow a locator. A `memory`
   locator must still be treated as a reference, not as authority to widen the
   granted scope.

Required adversarial cases before the hold clears: same-ID exact retry before
and after a later edit; changed reuse; copied/malformed/ambiguous/forgotten
receipt; stale, zero-head and duplicate-head writes with byte-identical vault
output; save failure after log rolling; duplicate headings; explicit empty next
actions; Tier-1 secrets in every nested output and conflict; generic edit making
a read revision stale; scope/grant denial; lock during an in-flight UI response;
unavailable and instruction-like file locators; and proof that no new hosted or
network path is called.

## Binding amendments before implementation

The request fingerprint is the JSON serialization of a server-constructed validated logical request with fixed key order, not transport JSON bytes. It includes vault ID, project, mode, expected revision, every present authored field (omission differs from empty), and ordered file references. Text preserves exact Unicode code points; do not NFC-normalize or trim authored text. Use the existing cryptographic digest primitive over that serialization. Operation ID is the lookup key, excluded from the request fingerprint.

Reserve metadata key `northkeep_project_handoff_v1`. Strictly validate its version, original result ID, project, base revision, mode, fingerprint and archive IDs before replay. Ordinary edits can copy metadata, so only the recorded original result ID owns the receipt. The dedicated Vault primitive writes metadata itself, creates archives, appends the head and supersedes the source inside one SQLite transaction. A malformed identifiable receipt refuses replay. Callers enforce grants before lookup. Legacy local project_update requires expected_revision equal to the current ID for an existing project, and explicit null for creation. It must also use an atomic project update primitive; it need not create a handoff receipt when no operation ID was supplied.

Completed work becomes a dated Log entry prefixed Checkpoint or Wrap up. `open_questions` replaces an owned `Open Questions` Markdown section; `files` replaces an owned `Files` section with a readable fenced JSON list of the validated reference objects. Parse only that exact bounded schema as file references; legacy free-form Files text remains visible as unstructured text, without invented access claims. Do not change the shared project-doc parser or its connector copy solely for these extra headings. Omission preserves both sections; explicit empty values clear them. Duplicate owned section headings refuse writes as ambiguous. What & Why and unrelated extra sections remain intact. Empty next_actions is valid. Status and completed must be nonempty for checkpoint/wrap.

Every nested project textual output from local MCP, including list, resume, conflict, history, files and errors, respects the existing Tier-1 return-masking setting. Revision IDs stay unchanged. When masking is enabled, exact-write checkpoint/wrap/update tools refuse and explain that a user must review and save in the local UI; this avoids silently round-tripping masked content into the vault. Read operations are still useful. Return errors without echoing arbitrary request/document text into the content-free audit log.

All handoff core callbacks are synchronous, bounded and do no network/model/filesystem probing while holding the file lock. Successful vault save may trigger existing opted-in automatic sync; the receipt establishes local durability and does not wait for or certify delivery. Shared content continues through the existing consented paths. A retried old operation returns its saved receipt separately from the current project, never labels the old document current.

These binding amendments supersede conflicting earlier wording, including transport-byte exactness and the old `reported` access enum. File access is `reported_available`, `unavailable` or `unverified`; reported_available requires a valid checked_at timestamp and a bounded nonempty context identifying the basis of that report.

For authored section values, reject leading/trailing newline runs, CR characters and whitespace-only nonempty strings. Accept exact empty strings only for clearable optional sections and next_actions. Preserve interior newlines and Unicode code points. This makes accepted section values round-trip exactly through the existing Markdown serializer. Completed work is visibly formatted into a dated Checkpoint/Wrap up log entry; receipt request binding preserves its accepted text, while the UI preview names that formatting. Reject ATX headings in authored replacement fields to prevent section injection; literal heading content remains visible in existing documents and must not be silently changed.

ProjectView.history contains at most 20 superseded working document revisions in that project scope, newest insertion first, excluding forgotten entries. Each has id, updated_at and exact document content; mode appears only from a validated original handoff receipt. The current Log section is returned separately as log text, and at most 20 episodic log archives appear in a separate archives array when history is requested. The UI labels these distinctly as saved versions and older log entries and reports bounded results rather than implying complete history. Existing project_get(history) archives semantics stay available.

**Final gate verdict: CLEAR for local implementation under these binding
amendments.** The amendments resolve every mandatory finding from this review.
Clearance is limited to the approved Projects surface and revision-bound
Codex-to-Claude-Desktop flow against one local vault. It does not clear hosted
tool changes, distributed coordination, automatic artifact access, assistant
configuration changes, production deployment, or claims that another client
received a locally saved handoff. Implementation must pass the adversarial cases
listed above before the milestone can be presented for owner acceptance.

## Implementation verification

Core, MCP and HTTP write paths received independent review after implementation. The browser exercised exact review/save, back-to-edit preservation, a competing-client stale write, keyboard dismissal, narrow layout and both appearances. Codex and Claude Desktop completed a real checkpoint/resume/wrap against one disposable vault through the local MCP test client. Persisted response evidence and scope limitations are recorded in `docs/projects-acceptance.md`. No installed connector configuration or deployment was changed.
