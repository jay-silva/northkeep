# ADR 0086: Share projects by default

Status: Proposed 2026-11-22 · Review: not yet run

## Context
Every project is private until Jay shares it, one at a time, from the app. On 2026-11-22 Gemini in Antigravity, reaching NorthKeep through the Cloud connector, could not find the bourne-fire project because it was never shared. Jay wants his projects shared unless he says otherwise, and rarely opens the app. Invariant #1(b) requires each shared scope to be individually marked, loudly confirmed, badge-visible and reversible.

## Decision
- D1: A vault setting, `share_projects_by_default`, in `vault_meta`, off in every vault. Like a scope mark (ADR 0038 D3), it applies on every device that syncs this vault. Only the app and the CLI change it.
- D2: Turning it on lists every unshared `project:*` scope with a box each, all ticked, and asks once. Each ticked scope is marked Shared, the same as a manual share. Unticked ones stay private.
- D3: While it is on, creating a project on this Mac (app, CLI or local `project_create`) marks its scope Shared in the same save. Projects created through the Cloud connector are already shared (ADR 0050).
- D4: Local `project_create` gains `private: true`. The contract tells the agent, when the setting is on, to say the new project will be shared and to ask whether to keep it private. With `private: true` the scope is not marked.
- D5: A local agent may unshare a project (a `project_unshare` tool, the same server-side delete and tombstone as the app). No agent can share a scope or change the setting.
- D6: A project Jay unshares stays unshared while the setting is on; D2 runs only at switch-on.
- D7: Turning the setting off shares and unshares nothing.

## Consequences
- Easier: new projects reach cloud apps with no trip to the app.
- Harder: every memory saved into a shared project scope is pushed, so a fact an agent files under a project leaves the Mac. Turning it on can push many projects at once.
- Committed to: KNOWN-LIMITS says the setting syncs across devices, that agents can make a project private but never shared, and that an agent which skips the question shares the new project.

## Rejected
- An agent-callable share: a prompt-injected agent could send a private project off the Mac.
- Asking in the app at each create: Jay rarely opens it.
- Sharing all scopes, not just projects: memories outside projects stay private.

## What leaves the machine
With the setting on: every ticked project at switch-on, and each project created on this Mac afterwards, go to the same account's connector store, encrypted as any shared scope. No new recipient or content class.

## Links
Extends: ADRs 0038, 0050 · Design record: to follow in docs/design/
