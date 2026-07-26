# ADR 0036: Filesystem tools

- **Date:** 2026-07-25
- **Status:** Proposed
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0027 (harness umbrella), ADR 0029 (harness security model), ADR 0033 (MCP trust model)

## Context

ADR 0027's milestone map named "filesystem and browser tools each behind their
own ADR." The public roadmap lists them as Exploring. This is the filesystem one.

The appeal is obvious: "summarize this contract", "what changed in these two
versions", "pull the numbers out of that spreadsheet" are the tasks a memory
vault owner actually has. The reason it needs its own ADR rather than riding
M11's is that **a filesystem tool is the first tool whose blast radius is the
user's whole machine**, and the vault is a file on it.

### What makes this different from every tool shipped so far

`web_fetch` reaches outward to a place the user approves. An MCP server is a
program the user installed. A filesystem tool reaches **inward**, at whatever
the NorthKeep process can read — which on macOS is everything the user can read,
including `~/.ssh`, browser cookie stores, other apps' data, and
`~/.northkeep/vault.nkv` itself.

Three consequences follow, and they shape every decision below:

1. **Reading is not safe just because it does not write.** File content returns
   into the conversation and then travels to whichever model answers. A read tool
   is an exfiltration primitive pointed at the local disk.
2. **The prompt-injection story inverts.** ADR 0029 worries about hostile content
   coming *in* from the web. Here, hostile content already on disk (a README, a
   downloaded PDF) can instruct the model to read something else and put it in a
   subsequent tool call.
3. **The vault is in scope by default unless excluded.** A tool that can read
   `~/.northkeep/vault.nkv` hands a cloud model the ciphertext; one that can read
   the device secret alongside it is worse.

## Decision 1: no ambient filesystem access — only user-granted roots

There is no "read any file" tool. The user grants **directories**, explicitly,
one at a time, and tools operate only inside them. A path outside every granted
root is refused before anything is read, with the reason.

This inverts the web model deliberately. `web_fetch` may reach any host and asks
per call; a filesystem tool may reach only pre-granted places and *also* asks.
The difference is that the web is a place you visit and your disk is a place you
live: an accidental "yes" to `~/` is unrecoverable in a way that an accidental
fetch is not.

Roots are stored like every other setting: `~/.northkeep/files.json`, version
field, 0600, tolerant loader, strict writer, fail-closed.

## Decision 2: four paths are refused even inside a granted root

Even if the user grants `~`, these are never readable:

- `~/.northkeep/**` — the vault, the device secret, grants, budgets, MCP config.
  A tool that can read the vault file makes every other control theatre.
- Anything matching the **secret-file shapes**: `.ssh/**`, `.aws/**`, `.gnupg/**`,
  `*.pem`, `*.key`, `*.p12`, `.env*`, keychain files, browser profile
  directories.
- **Devices and pipes** — `/dev/**`, sockets, FIFOs. A read of `/dev/random`
  never terminates and is a trivial denial of service.
- Anything reached by **symlink or `..` traversal out of a granted root**. Paths
  resolve with `realpath` before the check, exactly as `resolveCommand` does
  (ADR 0033), because a symlink is a redirection and checking the pre-resolution
  string is checking a name rather than a target.

This list is a floor, not a policy. It is refused regardless of grants, and it is
not user-configurable, because the failure mode of getting it wrong is
unrecoverable.

## Decision 3: read, write and delete are three different risk classes

- **read** — `safe-read` in ADR 0029's terms. May hold an `always` grant *for a
  specific root*.
- **write / create** — `consequential`. Asks every time, showing the path and a
  size. Never holds an `always` grant.
- **delete / move / overwrite** — `consequential`, and additionally **refuses
  outright in v1**. There is no undo, the model is a poor judge of what matters,
  and nothing in the memory-vault use case needs it. Revisit only with a
  concrete need.

## Decision 4: results are content, and are treated as such

File content re-enters the conversation and then goes to the model under
invariant #1(a). Therefore:

- Results are **fenced as untrusted** (already unconditional in the loop since
  M11 — the fence keys on "a tool produced this").
- Results are **truncated** to the existing per-result cap, with the truncation
  visible.
- **Binary is refused, not mangled.** A file that does not decode as text is
  reported as binary rather than dumped as replacement characters.
- The turn's proof names **which files were read**, so "what left this machine"
  stays true when the answer travels to a cloud model.

## Decision 5: the exfiltration screens apply to paths, and gain a new class

`screenArguments` decomposes a URL today. A filesystem call's argument is a
**path**, and the interesting screen is different: does this path look like a
credential store, a vault, or a location the user never meant to expose? That is
Decision 2's list, applied as a *screen* (warn and force a prompt) as well as a
*floor* (refuse), for the near-misses the floor does not catch — `Documents/
old-ssh-backup/`, say.

The memory and identity screens still apply to the path string itself, since a
path can carry a name.

## Decision 6: this does not change invariant #1, and that is worth stating

Invariant #1 governs **memory content**. A file the user asks about is not vault
content, so reading `contract.pdf` and sending it to a selected model provider is
covered by clause (a) as ordinary conversation content, not by (c).

What *would* implicate the invariant is a filesystem tool reading
`~/.northkeep/**`, which Decision 2 refuses outright. If that refusal is ever
relaxed, the invariant must be revisited first, not afterwards.

## What this does not do

- No `delete`, `move` or `overwrite` (Decision 3).
- No recursive whole-tree reads. Listing is separate from reading and is bounded.
- No writing outside a granted root, ever, even with approval.
- No execution. A filesystem tool never runs what it reads.

## Honest limits

- **A granted root is granted.** Once the user grants `~/Documents`, a read of
  anything in it needs only the per-call approval, and an `always` grant removes
  even that. The floor list still applies, but a tax return in that folder is
  readable.
- **Content on disk can be hostile.** A file can contain instructions aimed at
  the model. Fencing bounds it; it does not solve it, exactly as for the web.
- **We can prove what we read; we cannot prove what the model then did with it**
  beyond the turn's own proof and audit.
- The floor list is a denylist of known-dangerous shapes and will be incomplete.
  It is a floor under the grant model, not a substitute for it.

## Acceptance test (Jay runs this himself)

1. With no granted root, every filesystem tool refuses and says so.
2. `northkeep files grant ~/Documents` then a read inside it asks for approval
   showing the exact path; a read of `~/Desktop/x.txt` refuses.
3. A read of `~/.northkeep/vault.nkv` refuses even after granting `~`.
4. A symlink inside `~/Documents` pointing at `~/.ssh/id_rsa` refuses.
5. A write asks every time and never offers "always"; a delete is refused.
6. Reading a binary file reports binary rather than dumping bytes.
7. The turn proof names the files read, and the audit records the call
   content-free.
