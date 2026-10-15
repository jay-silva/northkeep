# Acceptance: notes and claims between AI apps (ADR 0072)

Passing means: a claim made in one AI app shows in another, a second claim on the same subject is refused, and the optional Claude Code hook shows notes without touching your real vault.

## Part 1: on a throwaway vault (any time, safe)

From the NorthKeep checkout on the Mac, on this branch:

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm exec vitest run packages/core/test/project-notes.test.ts packages/mcp-server/test/notes-tools.test.ts
pnpm exec vitest run --config e2e/vitest.config.ts e2e/agent-notes.test.ts
```

Expect every test to pass. The tests make a temporary NorthKeep folder and delete it after; they never read or write your vault or your Keychain. On a Mac, the six hook tests that need a stored key are skipped on purpose, because storing one would write to your real Keychain; they ran on Linux.

What the e2e file proves: three real server processes named as Cursor and Claude Code share one notes file; a claim made in Cursor shows in two Claude Code sessions; three processes racing for one subject leave exactly one winner; the owner CLI lists and releases a claim; the hook prints nothing without a stored key.

## Part 2: on your real setup (after the change is merged and installed)

1. In Cursor, ask: "Use NorthKeep project_note to claim subject test-claim in project northkeep for 1 hour."
2. In Claude Code, ask: "Run NorthKeep project_resume for northkeep." The result lists `active_claims` with cursor holding test-claim, and a `notes_notice`.
3. In Claude Code, ask it to claim test-claim too. It is refused with `claim_held`, naming Cursor and the expiry.
4. In Terminal: `northkeep notes --project northkeep`. You see the claim and its id. Then `northkeep notes --project northkeep --release <id>`.
5. Optional hook: add the recipe from docs/design/agent-notes-and-claims.md to the repo's `.claude/settings.json` (that edit is yours to make). Have Cursor leave a note for claude-code; your next Claude Code prompt shows it once.

If step 2 shows nothing, check that Cursor and Claude Code use the same NorthKeep vault and the project slug is spelled the same.
