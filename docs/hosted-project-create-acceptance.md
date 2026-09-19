# Acceptance: a connected app creates a project (ADR 0050)

Run these on your Mac after the build is installed. Every step says what
you should see. Nothing here touches production until step 6, which you
run only after the local steps pass.

## 0. What changed, in plain words

- Claude.ai (and any app connected through Cloud Connect) gets a new tool,
  `project_create`. Until now it could only update a project you had
  already shared from NorthKeep.
- The project reaches your Mac the next time you press Sync on the
  Connect tab (or run `northkeep share sync`). If the project scope on
  your Mac is empty, it arrives marked Shared, with the badge, and no
  dialog. If your Mac already has anything in that scope, nothing is
  applied; NorthKeep tells you to share the scope if you want it.
- Local agents (Claude Code, Codex, Cursor, Claude Desktop) also get
  `project_create`. Creating with `project_update` and a null revision
  still works.
- The installed agent contract changes one sentence, so reinstall it.

## 1. Local tools (no network)

```bash
cd ~/Claude/Projects/NorthKeep/northkeep && pnpm -r build && pnpm test
```

Expect: every test green. The count is printed at the end.

Restart Claude Desktop and Claude Code, then in either ask:
"Create a NorthKeep project called acceptance-0050 whose purpose is to
test project creation, current status: created from a local agent."

Expect: the agent calls `project_create` and reports success. In the
NorthKeep app, Projects shows `acceptance-0050` without a Shared badge.

Ask the same agent to create it again. Expect: the tool refuses with
"Project already exists; use project_update."

## 2. Reinstall the contract

```bash
cd ~/Claude/Projects/NorthKeep/northkeep && node packages/cli/dist/index.js contract install claude
```

Expect: the file `~/.claude/rules/northkeep-projects.md` now contains the
sentence "Create a project with project_create only when the user asks
for one" and no longer contains "never create a project there".

## 3. Hosted create into an empty scope (needs the deployed connector)

Only after the connector deploy in step 6.

In Claude.ai with the NorthKeep connector, ask: "Create a NorthKeep
project called hosted-0050. Purpose: verify hosted creation. Status:
created in Claude.ai."

Expect: success text "Created project "hosted-0050". It will sync into
the vault."

On the Mac, Connect tab, press Sync (or):

```bash
cd ~/Claude/Projects/NorthKeep/northkeep && node packages/cli/dist/index.js share sync
```

Expect: "1 added" and the scope `project:hosted-0050` listed as pushed.
Projects shows `hosted-0050` with the Shared badge. Ask Claude Code to
read it with `project_get`: the status you typed in Claude.ai is there.

## 4. Hosted create that collides with a private project (must hold)

In Claude Code: "Create a NorthKeep project called private-0050, purpose:
collision test, status: private on the Mac." Do not share it.

In Claude.ai: "Create a NorthKeep project called private-0050, purpose:
from the cloud, status: cloud."

Press Sync on the Mac. Expect: the sync reports one held project and the
message "A connected app wrote to project private-0050, which is private
on this device. Share project:private-0050 in NorthKeep to accept it."
Projects still shows your local text, no Shared badge. Nothing from the
Mac's private-0050 appears in Claude.ai (`project_get` there still shows
only the cloud skeleton).

## 5. Unshare is the revoke

Unshare `project:hosted-0050` on the Connect tab. In Claude.ai ask to
create `hosted-0050` again. Expect: refused with "This scope was
unshared. Re-share it deliberately if you want it back."

## 6. Deploy (you say go)

Pushing main deploys the connector on Vercel. The exact command is in the
session report; it is not run without your yes for that push.

## Clean up

Delete `acceptance-0050`, `private-0050` and `hosted-0050` from the
Projects page when done.
