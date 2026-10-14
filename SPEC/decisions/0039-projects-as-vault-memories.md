# ADR 0039: Projects as vault memories: the project scope convention and MCP project tools.

Status: Accepted 2026-08-24 (M13) · Deciders: Jay, Claude Code · Review: gate did not fire; light adversarial pass on `memory_edit` scope enforcement, no design change · Corrected 2026-09-24 (release 0.22.0 doc-vs-code pass) per ADRs 0045, 0048, 0051, 0052

## Context
M13's outcome: a project started in one local client resumes cold in another, from the local vault. Memories already accept a `project:<name>` scope and a `working` type. This is a convention on existing schema: vault version stays 0.3, no new tables.

## Decision
- D1: A project is one live `working` memory in scope `project:<slug>`, slug `[a-z0-9-]{1,40}`. Markdown with five fixed headings: What & Why, Current Status, Next Actions, Decisions, Log; extra headings are preserved. No stored index: `project_list` is the index. Current state: more than one live `working` entry is refused as `project_conflict` (ADR 0048, originally newest-wins); writes go through `Vault.updateProject` and `Vault.checkpointProject` (ADR 0048); superseded history keeps the newest five revisions plus any a handoff receipt names, older ones become tombstones with the chain intact (ADR 0051); a draft line and writer block were added (ADR 0052).
- D2: Local MCP (`packages/mcp-server`) gains `memory_edit(id, content?, type?)`, `project_list()`, `project_get(project)` and `project_update(...)`, a structured merge (replace status, next actions, what and why; append Decisions; prepend Log). Current state: `project_update` creates only with `expected_revision: null` and needs the current revision to change one; `project_create` exists; the standing instruction says `project_resume` at start and `project_wrap` at end (ADR 0048).
- D3: `memory_edit` cannot change scope over MCP. The schema omits `scope`, and the handler builds its patch from `content` and `type` only. Rescope stays in the GUI and CLI (`northkeep rescope`), where share confirmation lives. The connection's `allowedScopes` still apply.
- D4: `PROJECT_DOC_MAX_CHARS = 16384`, never silently truncated. Current state (ADR 0045): an over-cap update moves the oldest Log entries into an archive memory; it is refused only when the hand-written sections alone exceed the cap.
- D5: Cloud Connect gets no project tools this milestone; Claude.ai and ChatGPT see a project only if its scope is Shared (connector tools: ADR 0040).

## Consequences
- Limits: two machines editing before sync still lose one side (whole-vault last-writer-wins; KNOWN-LIMITS). Agents cannot retype a project (ADR 0065); an owner retype hides it. Out-of-grant edits fail as "No memory found". `working` memories do not age out.
- Not built: Curator, connector project tools, new CLI commands, schema bump.

## Rejected
- `scope` on `memory_edit`: could turn private content shared without the share confirmation path.

## What leaves the machine
The original has no egress section. Its context says the review gate does not fire because "nothing new leaves the machine", and its review notes the share boundary stays the scope mark (ADR 0038), not the content inside it.

## Links
Amended by: ADRs 0045, 0048, 0051, 0052 · Builds on: ADR 0015 · Next: ADR 0040 · Full record: docs/design/adr-0039-projects-as-vault-memories.md
