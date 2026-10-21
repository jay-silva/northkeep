# Acceptance: notes and claims between AI apps (ADR 0072)

Passing means: a claim made in one AI app shows in another, a second claim on the same subject is refused, and the optional Claude Code hook shows notes without touching your real vault.

## Part 1: on a throwaway vault (any time, safe)

From the NorthKeep checkout on the Mac, on this branch:

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm exec vitest run packages/core/test/project-notes.test.ts packages/mcp-server/test/notes-tools.test.ts
pnpm exec vitest run --config e2e/vitest.config.ts e2e/agent-notes.test.ts
```

Expect every test to pass. The tests make a temporary NorthKeep folder and delete it after; they never read or write your vault or your Keychain. On a Mac, the eight hook tests that need a stored key are skipped on purpose, because storing one would write to your real Keychain; they run on Linux in CI.

What the e2e file proves: three real server processes named as Cursor and Claude Code share one notes file; a claim made in Cursor shows in two Claude Code sessions; three processes racing for one subject leave exactly one winner; the owner CLI lists and releases a claim; the hook prints nothing without a stored key.

## Part 2: on your real setup (after the change is merged and installed)

1. In Cursor, ask: "Use NorthKeep project_note to claim subject test-claim in project northkeep for 1 hour."
2. In Claude Code, ask: "Run NorthKeep project_resume for northkeep." The result lists `active_claims` with cursor holding test-claim, and a `notes_notice`.
3. In Claude Code, ask it to claim test-claim too. It is refused with `claim_held`, naming Cursor and the expiry.
4. In Terminal: `northkeep notes --project northkeep`. You see the claim and its id. Then `northkeep notes --project northkeep --release <id>`.
5. Optional hook: add the recipe from docs/design/agent-notes-and-claims.md to the repo's `.claude/settings.json` (that edit is yours to make). Have Cursor leave a note for claude-code; your next Claude Code prompt shows it once.

If step 2 shows nothing, check that Cursor and Claude Code use the same NorthKeep vault and the project slug is spelled the same.

## Part 3: conversations between AI apps (ADR 0079)

Passing means: Cursor asks Claude desktop a question and gets the answer back, the Mac app shows the exchange, and the Codex and Cursor hooks show a message after a tool call.

On a throwaway vault first (safe, as in Part 1):

```sh
pnpm exec vitest run packages/mcp-server/test/notes-hook.test.ts apps/web/test/project-notes-api.test.ts
```

After the change is merged and installed, quit and reopen Cursor, Claude desktop and Codex, so each starts a new NorthKeep server.

1. In Cursor, ask: "Use NorthKeep project_note to tell claude-desktop: are you in vault.ts? Then project_wait for a reply."
2. Within 20 seconds, in Claude desktop, ask: "Run NorthKeep project_resume for northkeep and reply to Cursor's note with project_note reply_to."
3. Cursor's wait returns the reply in the same turn. If step 2 came later, Cursor's next wait or project read shows it.
4. In the Mac app, open the northkeep project. The Conversation section shows the question and the indented reply, and "Seen by claude-desktop" under Cursor's question.

Hooks (these files are yours to edit; the recipes are in docs/design/agent-conversations.md, section Hooks):

5. Codex: save the Codex recipe as `~/.codex/hooks.json`. Start Codex, type `/hooks`, and trust the NorthKeep hook. Codex asks again whenever the file changes.
6. Cursor runs hooks from `~/.cursor/` and may not see the folders your Terminal searches. In Terminal, run `command -v northkeep` and copy the full path it prints. Save the Cursor recipe as `~/.cursor/hooks.json`, with that full path in place of `northkeep` in both commands.
7. Wait a minute after step 4, since the hooks check at most once a minute after tool calls. In Claude desktop, ask: "Use NorthKeep project_note to tell all: hook test." Then in Codex and in Cursor, ask: "List the files in this folder, then tell me whether a NorthKeep note appeared." Each names the hook test note.
8. PATH check: right after the Cursor step, run `northkeep log -n 5` in Terminal. A new `notes_hook` line means Cursor ran the hook. No line means Cursor could not find the command: check the path in `~/.cursor/hooks.json`.
