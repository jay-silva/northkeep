# ADR 0036: Filesystem tools

- **Date:** 2026-07-25
- **Status:** **PARKED 2026-07-26 by Jay. Not being built.** Two revisions were
  defeated empirically in two days: Revision 1's floor was beaten with a
  differently-cased path, Revision 2's with a UTF-8 byte-order mark. Kept as a
  decision record. See both reviews at the end.

## Why parked (2026-07-26)

The reviewable part is fixable. Revision 2's Class A leaks (BOM, truncation,
tar, base64, a device secret in any file that is not exactly 65 bytes) all close
by scanning for markers anywhere in the buffer instead of parsing or comparing
whole, and that fix was tested against every fixture. Eight concrete corrections
are listed at the end of the Revision 2 review.

**Class B is not fixable, and that is what decided it.** `northkeep export | jq
'.memories' > notes.json`, a CSV made from it, a paragraph pasted into a Word
document: after export these ARE ordinary user text, with no marker left to
detect. Whether reading one counts as "leaking the vault" is undecidable by
construction, not by effort.

Jay's bar was *"if any chance exists that we are gonna leak the vault its a no
go"*, and under a strict reading Class B sits inside it. The trade also does not
pay: the feature buys "summarize this contract" and costs a KNOWN-LIMITS entry
reading roughly *"if you exported your vault and built a spreadsheet from it, we
may read that spreadsheet"* — which is expensive for a product whose entire
claim is verifiable privacy.

**If this is ever revisited**, start from the Revision 2 review's eight required
changes, not from Revision 2 itself. One untested idea worth evaluating first:
the repo already has 16-gram overlap matching for the memory-class exfiltration
screen (`exfil.ts`), and pointing it INBOUND — screening file content against
the vault before returning it — would catch verbatim Class B artifacts, since a
`jq` slice contains memory text word for word. Paraphrase would still escape.
Unverified; verify before it changes any decision.
- ~~Proposed — **Revision 2, 2026-07-26, awaiting adversarial review.**~~
  Revision 1's floor was defeated on this machine (the reviewer read the real
  vault and the real device secret past it). Revision 2 below supersedes
  Decisions 2, 3 and 6. **Jay's bar for this milestone: if any plausible path
  exists by which the vault or the device secret can be read, the feature is not
  built at all.** Revision 2 either clears that bar or 0036 is parked beside
  0037.
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


## Adversarial review — 2026-07-25

Run under the CLAUDE.md review gate, against code at `5b6158b`, with experiments
on this machine. Recorded here rather than in a commit message, and corrected
rather than softened, following ADR 0035's precedent. **Verdict: do not
implement as written.**

### Critical

**C1 — Decision 2's floor is name-based, and macOS path aliasing defeats it.**
Demonstrated on this machine, with no attacker, no race and nothing
pre-planted:

- APFS is case-insensitive but `realpath` is case-*preserving*, so
  `~/.NORTHKEEP/vault.nkv` realpaths to itself and matches no glob written
  against `~/.northkeep/`. **573 KB of the real vault was read.**
- `/System/Volumes/Data/Users/…` is a **firmlink**, not a symlink: it realpaths
  to itself and is a second complete path to the home directory that never
  contains the string `.northkeep`. **The real `device.secret` was read.**
- The vault need not live in `~/.northkeep` at all (`--vault <path>`,
  `packages/cli/src/index.ts:83`), and `northkeepHome()` honours
  `NORTHKEEP_HOME` (`packages/core/src/platform.ts:8`). A literal floor path is
  wrong by construction; it must be computed at runtime.
- The sidecars `${vault}.tmp` and `${vault}.bak`
  (`packages/platform-node/src/storage.ts:21,32`) are not on the list.

*Correction required:* the vault half of the floor becomes an **identity**
check, not a name check — `open()`, `fstat()`, compare `dev`+`ino` against a
runtime-computed deny-set (resolved vault path plus `.bak`/`.tmp`,
`deviceSecretPath()`, everything under `northkeepHome()`), containment-check the
descriptor's own resolved path, and read from that descriptor. Say plainly that
the *shape* half (`.ssh/**`, `*.pem`, `.env*`) cannot be inode-enumerated and
stays heuristic. One list with one confidence level was the error.

*Counter-check, so this is not overclaimed:* `/Volumes/Macintosh HD/…` **is** a
real symlink and `realpath` collapses it correctly.

**C2 — Decision 6 is wrong in both directions.** Inbound: `northkeep export
--out` (`packages/cli/src/index.ts:289-305`) writes the entire vault as
plaintext JSON, and invariant #4 *requires* that it can. Users write it to
`~/Documents` — the ADR's own example grant. That file **is** vault content, and
Decision 6's "not vault content, so clause (a)" reasoning is exactly backwards
for it. Outbound: `distillExchange` (`packages/converse/src/turn.ts:586-631`)
commits extracted candidates to the vault at `memoryScope ?? 'personal'`
(`task.ts:986`), so whatever the assistant quotes from a read file becomes
permanent memory, syncs, and is eligible for a scope later marked Shared.

*Correction required:* add the configured vault path and sidecars to the
identity floor; decide explicitly what distillation does on a turn in which a
file was read (recommended: `distill: false` for that turn, or a visible
notice); test both. Credit where due: `turn.ts:611-613` already drops candidates
carrying a Tier-1 secret, and the default scope is `personal`.

**C3 — Decision 3's per-root `always` grant has no representation in the
engine, and the engine forecloses it.** `GrantSubject` is
`{ host } | { server }` (`policy.ts:43`); a filesystem call has neither, and
`policy.ts:266` states the consequence outright: no-egress calls "always ask in
v1." Worse, a root grant is **prefix inheritance**, which `policy.ts:22-28`
refuses by design for hosts ("a wildcard grant is exactly the kind of quiet
blanket permission this product refuses"). KNOWN-LIMITS L143-150 and ADR 0029
L211-227 already call the `always`-grant compound the strongest practical attack
in the threat model; Decision 3 points it at the local disk.

*Correction required:* drop `always` for filesystem reads in v1 — per-call
approval only. Adding a third grant subject is "changes who decides" and needs
its own ADR and review first. Any root subject must then be bound by the root's
`dev`+`ino`, or C1's aliasing reopens at the grant layer.

### High

- **H1 — `realpath`-then-read is TOCTOU** (demonstrated: check passes, symlink
  swapped, secret read). The cited precedent is also miscited: `resolveCommand`
  (`identity.ts:97-115`) canonicalizes for *fingerprinting* and performs no
  containment check. The containment function is `isUnderAllowedRoot`
  (`identity.ts:194-216`) — cite that, and note it is still a string
  comparison. **Hardlinks are invisible to any name-based rule**, including
  `realpath`; same fix as C1.
- **H2 — "the turn's proof names which files were read" describes a surface
  that does not exist.** `toolCallsMade` (`task.ts:146-162`) carries `host`,
  `egress`, `mcpServer`, `argsSent`; a file read supplies none. A third shape is
  needed in both the struct and the ADR-0031 `done` schema. Also worth a
  sentence: for web and MCP the proof reports what *left*; for a file read it
  reports what *entered*.
- **H3 — the screen claim is half true, and the failing half is the one that
  matters.** True and free: `screenArguments` runs on every call before the
  gate (`task.ts:626-639`), every string leaf becomes a `body` candidate
  (`exfil.ts:135-158`), so identity/memory screens do apply to a path string.
  False: the leak is what comes *back*, on turn N+1, and the memory screen's
  corpus is fed only by `recordDisclosedMemory(session, used: ScoredEntry[])`
  (`turn.ts:135-140`) — **vault entries only**. That function's own docstring
  says "EVERY path that puts memory in front of the model must call this." A new
  decision is required: file content read this conversation joins the screen
  corpus, with a size bound. Three smaller items in the same decision: the
  proposed "credential store" class does not exist (`ExfilClass` is
  `secret | identity | memory`, `exfil.ts:27`, with a fixed phrase table at
  `:514`); `where: 'path'` already means "the URL's path" (`exfil.ts:485`) and
  would mislabel a file read; and `HARD_DENY_SECRET_KINDS` (`task.ts:66`) would
  silently make `2024-tax-123-45-6789.pdf` un-approvable — argue explicitly
  whether hard-deny should apply to a no-egress read.
- **H4 — macOS omissions, and a TCC problem to get ahead of.**
  `~/Library/{Keychains,Messages,Mail,Safari,Containers}` must be refused **by
  name, before being touched**, so NorthKeep never triggers an OS "would like to
  access data from other apps" prompt it cannot explain. Also missing: SQLite
  `-wal`/`-shm` sidecars, Time Machine local snapshots, resource forks
  (`..namedfork/rsrc`), `._AppleDouble`, extended attributes, `.DS_Store`. State
  *why* `/dev/**` is refused (`/dev/fd/*` reaches arbitrary open descriptors) so
  a future narrowing does not reopen it.
- **H5 — no pre-read size or type bound.** Truncation here is post-hoc
  (`truncateChars`, `task.ts:171-173`, `DEFAULT_MAX_RESULT_CHARS = 20_000`);
  `web_fetch`'s real bound is the streamed 2 MB cap in `net.ts`. Reading a huge
  file fully into memory to emit 20 000 characters is the same DoS the
  `/dev/random` clause anticipated. Add: `fstat` the descriptor, refuse
  non-regular files by mode (subsumes FIFOs and sockets more reliably than
  `/dev/**`), refuse above a stated byte cap, apply a deadline. Note iCloud
  dataless files in `~/Documents`/`~/Desktop` — reading one triggers a download
  and can hang.

### Medium

- **M3 — `safe-read` is claimed "in ADR 0029's terms" and 0029 defines no such
  term.** The only definition is a code comment (`types.ts:42-46`) and it is
  egress-shaped: "read-only egress (a fetch)." A file read has no egress, which
  is the point this ADR's own Context makes at lines 29-31. Define the term
  here, or give filesystem read its own risk class. Do not borrow a definition
  that does not fit.
- **M5 — "listing is separate from reading and is bounded" does unexamined
  work.** A listing *is* disclosure; filenames are content. Listing needs its
  own paragraph: risk class, floor interaction (are refused paths hidden or
  shown as refused? probably shown), screens, and an explicit entry cap.

### Low

- **L1 — `modelTier` is still dead code.** Set at `task.ts:697`, declared at
  `gate.ts:21`, read by no consumer. Wire it or delete it before adding a second
  never-read field. (ADR 0035 cites `task.ts:682` for this; the actual site is
  `:697`.)
- **L2 — no KNOWN-LIMITS obligation.** ADR 0033:92 set the precedent. This ADR
  would falsify the privacy-ceiling entry (L188-200), whose reasoning is
  entirely about network tools and never contemplates disk content entering the
  conversation.

### What survives, stated plainly

Verified and sound, keep as written: **Decision 1** (no ambient access,
per-directory grants, the `files.json` version/0600/tolerant-loader idiom
matching every other config); **Decision 3's write/delete split** — `policy.ts:322`
makes `consequential` ask unconditionally above any grant, so "never holds an
`always` grant" is a property of the engine, not a promise, and refusing
delete/move/overwrite in v1 is right; **Decision 4**, all four sub-claims —
the fence keys on "a tool produced this" (`task.ts:858-872`), truncation is
real, results are re-redacted at the model's tier every step; **Decision 5's
second paragraph**; and the **Honest limits** section, which is the strongest
part of the document and is materially correct.

### Prerequisites before any code

1. Rewrite Decision 2 as an identity check with fd-based reads (C1, H1).
2. Drop the per-root `always` grant, or write the permission-engine ADR first (C3).
3. Rewrite Decision 6 for both directions (C2).
4. Add file content to the exfil screen corpus (H3).
5. Add the macOS omissions, the pre-read size/type bound, and the listing
   paragraph (H4, H5, M5).
6. Expand the acceptance tests — configured vault path, hardlink, case variant,
   firmlink path, an `export --out` file in a granted root, a large-file refusal,
   and a read-then-`web_fetch` screen — and add the KNOWN-LIMITS obligation.


# Revision 2 — 2026-07-26

**Supersedes Decisions 2, 3 and 6.** Written after the adversarial review below
defeated Revision 1's floor, and after measuring the proposed replacement on the
target machine rather than reasoning about it. Every claim in this section that
says "verified" was executed on Jay's Mac on 2026-07-26; the numbers are real.

## The mistake Revision 1 made, stated once

Revision 1 asked *"is this path allowed?"* Paths are names, names have unbounded
aliases, and macOS supplies more aliases than any denylist enumerates. Revision 2
asks two different questions instead: **"what is this file?"** and **"which
object am I actually holding?"** Neither has aliases.

## Decision 2 (revised): four layers, and an explicit confidence for each

Applied in this order, for every read.

### L1 — Content refusal. Exact, path-independent, catches every copy.

Refuse the file, wherever it lives and whatever it is called, if:

- its first four bytes are `NKV1` — the vault magic (`packages/core/src/vault.ts:44`).
  Any vault, any copy, clone, backup, rename, or snapshot of one.
- its contents equal the live device secret. That file is 64 hex characters plus
  a newline (`packages/core/src/platform.ts:33`), so this is a 65-byte exact
  comparison, not a heuristic.
- it parses as a NorthKeep export — our own schema, our own marker.

**Why this layer leads, and why Revision 1 could not have worked without it.**
An identity-based floor still misses every *copy*. Verified: an APFS clone of a
file receives a **different inode** (`16777230:149845706` vs
`...707`). So `cp ~/.northkeep/vault.nkv ~/Documents/backup.nkv`, an APFS clone,
and a Time Machine local snapshot (this machine has several: `tmutil
listlocalsnapshots /`) are all distinct filesystem objects containing the whole
vault. Content is the only property every copy shares.

This layer also subsumes finding C2's inbound half: `northkeep export --out`
writes plaintext JSON that invariant #4 *requires* to exist, frequently into
`~/Documents`, and it is refused by what it contains rather than by where the
user happened to put it — which keeps working after they move or rename it.

### L2 — Identity deny-set. Exact, alias-independent, computed at runtime.

Refuse when the opened descriptor's `dev`+`ino` is in a set built at check time
from: the **configured** vault path (never a literal — `--vault` exists,
`packages/cli/src/index.ts:83`), its `.bak` and `.tmp` sidecars
(`packages/platform-node/src/storage.ts:21,32`), `deviceSecretPath()`, every
entry under `northkeepHome()` (which honours `NORTHKEEP_HOME`,
`packages/core/src/platform.ts:8`), and the enumerable secret stores —
`~/.ssh/*`, `~/.aws/*`, `~/.gnupg/*`, `~/Library/Keychains/*`.

Verified on this machine: `~/.northkeep` and `~/.NORTHKEEP` are the same inode
(`16777230:139523843`), and so is
`/System/Volumes/Data/Users/jsilva/.northkeep`. The APFS case-insensitivity
bypass and the firmlink bypass — the two that defeated Revision 1 — both
collapse here. So does a hardlink: verified, a hardlink under an innocent name
carried the target's exact inode.

Enumerating the secret stores as *inodes* rather than leaving them as globs is
what makes a hardlink to `~/.ssh/id_rsa` refusable under any filename.

### L3 — Containment by inode ancestor walk.

"Is this file inside granted root R" is answered by walking the file's resolved
ancestors and requiring one of them to **be** R, by `dev`+`ino` — not by string
prefix. Verified: correctly accepts a case-variant and a firmlink path to a file
genuinely inside the root, and correctly rejects the firmlinked vault as being
inside `~/Documents`.

### L4 — Ordering. Open first, then decide, then read only from that descriptor.

`open()` → `fstat()` the descriptor → apply L1/L2/L3 → read from **that
descriptor**, never re-opening by name. Verified against a live attack: check a
path, unlink it, replace it with a symlink to a secret, then read. Re-opening by
name returns `SECRET`. Reading from the descriptor opened first returns
`PUBLIC`, with the swap already committed underneath it.

### Also required, each cheap and bounded

- **Refuse `nlink > 1`.** A read tool has no legitimate need for hardlinked
  files, and the link count is the visible tell for the whole hardlink class
  (verified: `nlink: 2` on the planted link).
- **Refuse non-regular files by `fstat` mode.** Subsumes `/dev/**`, FIFOs and
  sockets more reliably than a path rule — and note *why* `/dev` matters: this
  process holds the vault open, so `/dev/fd/N` is a path to it.
- **Refuse above a byte cap before reading, with a deadline** (H5). Truncation
  in this codebase is post-hoc (`task.ts:171-173`); the real bound must be
  pre-read. Covers stalled network mounts and iCloud dataless files in
  `~/Documents`, which is the ADR's own example grant.
- **Refuse `~/Library/{Keychains,Mail,Messages,Safari,Containers,Application
  Support}` by NAME, before touching them** (H4), so NorthKeep never triggers a
  TCC prompt it cannot explain. For a verifiable-privacy product that dialog is
  a product incident whichever way the user answers.
- **Listing gets its own paragraph** (M5): same floor, same screens, its own
  risk class, an explicit entry cap, and floor-refused entries shown as
  `refused` rather than hidden, so a user can see the floor working.

## What is exact and what is not

Revision 1's error of presenting one list at one confidence level is not
repeated.

**EXACT — no known path, and the mechanism admits no aliases.** The vault and
any copy of it; the device secret and any copy of it; any vault export; and
every live object under `northkeepHome()`, under any name, any case, any link,
any mount path.

**HEURISTIC — best effort, will be incomplete.** The shape globs: `*.pem`,
`*.key`, `.env*`, `id_rsa` outside `~/.ssh`, `*.mobileprovision`. These cannot
be inode-enumerated because they describe files that do not exist yet.

**RESIDUAL, stated rather than hidden.**
- A swap-and-swap-back race between `realpath` and `open` remains theoretically
  possible, because macOS gives no way to recover an open descriptor's true path
  from Node — verified, `realpath('/dev/fd/N')` returns `/dev/fd/11`, not the
  file. Its worst case is reading a file already inside a granted root, and L1
  and L2 both act on the descriptor, so the vault is not reachable through it.
- A user-made export in some format we do not recognise (a manual copy-paste
  into a Word document) is not detectable by content and is ordinary user data.

## Decision 3 (revised): no `always` grant for filesystem reads in v1

Dropped, per finding C3. The engine has no subject for a directory
(`policy.ts:43`), documents that no-egress calls always ask (`policy.ts:266`),
and refuses prefix inheritance by design for hosts (`policy.ts:22-28`) on
reasoning that applies identically to directories. Per-call approval only.
Adding a third grant subject is "changes who decides" and needs its own ADR.

## Decision 6 (revised): distillation is off for a turn that read a file

`distillExchange` (`turn.ts:586-631`) commits extracted candidates to the vault
at `memoryScope ?? 'personal'` (`task.ts:986`). Quietly copying a contract into
the user's vault is not a defensible default, so a turn in which a filesystem
read executed sets `distill: false`. The inbound half of C2 is handled by L1.

## Decision 10 (new): file content joins the exfiltration screen corpus

Per finding H3. `recordDisclosedMemory` (`turn.ts:135-140`) is fed by vault
entries only, and its own docstring says "EVERY path that puts memory in front
of the model must call this." A filesystem read is such a path, so content read
this conversation joins the corpus, size-bounded, and a later `web_fetch`
carrying it is flagged. Also from H3: `where: 'path'` already means "the URL's
path" (`exfil.ts:485`), so filesystem arguments must not reuse it; and
`HARD_DENY_SECRET_KINDS` (`task.ts:66`) should not apply to a no-egress read,
or `2024-tax-123-45-6789.pdf` becomes silently un-approvable.

## Acceptance test for Revision 2

Every one of these must refuse, and each targets a specific defeated bypass:

1. `~/.northkeep/vault.nkv` (baseline), after granting `~`.
2. `~/.NORTHKEEP/vault.nkv` (APFS case-insensitivity).
3. `/System/Volumes/Data/Users/<you>/.northkeep/vault.nkv` (firmlink).
4. `cp ~/.northkeep/vault.nkv ~/Documents/holiday-photos.nkv`, then read it
   (copy — inode differs, content does not).
5. The same copy renamed to `notes.txt` (content, not extension).
6. A Time Machine local snapshot path containing a vault.
7. `~/.northkeep/device.secret`, and a copy of it under any name.
8. `northkeep export --out ~/Documents/x.json`, then read it.
9. A hardlink in `~/Documents` to `~/.ssh/id_rsa`.
10. A symlink swapped between approval and read (must read the approved file, or
    refuse — never the swapped one).
11. A vault at a non-default `--vault` path inside a granted root.
12. A 4 GB file, and a FIFO, both refused before any read.
13. `~/Library/Keychains/login.keychain-db` refused without triggering a TCC
    prompt.


# Adversarial review of Revision 2 — 2026-07-26

**VERDICT: PASTURE as written.** Revision 2 leaked all three protected
categories. The reviewer implemented Decision 2's four layers verbatim in Node
and attacked the implementation with mock fixtures, never copying the real vault,
secret or export anywhere on disk.

## The structural error

L2, L3 and L4 are exact for **live objects** — every inode measurement in
Revision 2 was independently reproduced. But **L1 is the only layer that catches
copies, and L1 was three narrow point-checks presented as a class**: magic at
byte 0, whole-file 65-byte equality, and whole-file `JSON.parse`. Each falls to a
one-step transformation of the container.

So Revision 2's claim — "**EXACT** … the vault and any copy of it; the device
secret and any copy of it; any vault export" — is false as written. Under the
CLAUDE.md review gate that is both a leak class and a published-claim defect.

## Class A — marker present, container transformed. FIXABLE.

Each verified by execution:

- **A UTF-8 BOM defeats the export check.** Open `export.json` in a text editor,
  save it, and `JSON.parse` throws on the leading `﻿`. Pure ordinary user
  behaviour; no attacker involved. This one case is the whole indictment.
- **A truncated export** also fails `JSON.parse` — and reads are capped at
  `DEFAULT_MAX_RESULT_CHARS` anyway, so the attacker loses nothing. The first
  20 000 characters of the truncated and pristine files were byte-identical,
  27 memory entries visible in both.
- **A tar of an export** decides on a mechanism Revision 2 never specifies: NUL
  is valid UTF-8, so "does it decode as text" passes it while "contains NUL"
  refuses it. The binary rule is load-bearing and undocumented.
- **The device secret in any file that is not exactly 65 bytes** — and
  `platform.ts:44-45` tells users to *"restore it from your backup"*, so a
  labelled line in a notes file is the behaviour the product invites.
- **Base64 of the vault** passes every layer.
- Also: export plus an appended line, two exports concatenated, an export
  wrapped in a parent object, an export saved as a JS module.

**The fix, tested rather than asserted: replace parse/compare-whole with SCAN.**
`NKV1` anywhere in the buffer, `northkeep_export` as a byte substring, the
64-hex secret as a substring, plus a phase-aligned base64 needle. That refused
every Class A fixture with no false positives on innocent files.

## Class B — marker absent, content derived. NOT FIXABLE.

`northkeep export | jq '.memories' > notes.json`. A CSV made from it. A paragraph
pasted into a Word document. After export, these **are** ordinary user text, and
no content check distinguishes them from any other document the user wrote.
Undecidable by construction.

**This is the decision, and it is Jay's, because it narrows or widens his own
bar rather than answering it.** Strict reading of "if any chance exists that we
are gonna leak the vault" → Class B is inside the bar and 0036 is parked no
matter how good the engineering. Narrow reading — the vault, the secret, and the
export as our tool produces it, plus near-misses — → Class A fixes suffice.

## Confirmed weaknesses that do not reach the vault

1. **Nothing binds the validated name to the held descriptor.** L1/L2 act on the
   fd, L3 necessarily acts on a name, so containment can be decided about a
   different object than the one held. Fix: require
   `stat(realpath(path)).dev/ino === fstat(fd).dev/ino`. **This also corrects
   Revision 2's residual paragraph** — the worst case is reading a file OUTSIDE
   the granted root, not "a file already inside a granted root."
2. **L3's wording admits two implementations, one of which is a grant escape.**
   Pin it to `realpath(file)`, not `realpath(dirname)`.
3. **Error paths are undefined and one is reachable today.**
   `~/Documents/x.txt/..namedfork/rsrc` throws `ENOTDIR` in the ancestor walk.
   Fail-open on an exception is a leak; the ADR must say fail-closed.
4. **L2 enumeration must be recursive, at check time.** Demonstrated: a
   one-level `readdir` allows `nkhome/mcp-servers/nested-secret.json`.
   Corroboration that hand-listed sidecars fail: `${vaultPath}.pulled.tmp`
   (`packages/sync/src/client.ts:212`) is a fourth sidecar Revision 2 missed.
5. **The `~/Library` name list omits directories this app already creates** —
   `Caches/ai.northkeep.desktop`, `WebKit/ai.northkeep.desktop`. Empty of memory
   content today, so a list gap rather than a leak.
6. **The operation set is not closed**, and "listing gets the same floor"
   contradicts the byte cap (applying L1 to every entry means reading every
   entry).
7. **`nlink > 1` is cost without marginal benefit** — L2's enumeration already
   refuses the hardlink, and APFS clones are `nlink=1`. Harmless, not
   load-bearing.
8. `northkeep remember '<content>'` writes memory content into shell history by
   construction. Belongs in Honest limits.

## Claims checked and found TRUE

`NKV1` at byte 0 of the real vault; the device secret 65 bytes; both Revision-1
bypasses collapsing to `16777230:139523843`; APFS clones getting new inodes;
hardlinks carrying the target inode; fd-first ordering defeating the swap;
`/dev/fd/N` carrying the true inode under `fstat`. **No plaintext SQLite
anywhere** — the vault is serialized in memory and encrypted before
`writeAtomic` (`packages/platform-node/src/storage.ts:20-41`), and no
`-wal`/`-shm` sidecar for it exists. **The audit log is genuinely content-free**
(`packages/mcp-server/src/log.ts:10-77`), so `northkeep audit --out` into a
granted root is not a leak channel.

## Two errors in Revision 2's own writing

- **The Time Machine justification was overstated.** This machine has no
  Data-volume snapshots (`tmutil destinationinfo` → no destinations; only sealed
  system-volume `com.apple.os.update-*` snapshots), and mounting an APFS snapshot
  needs root. Acceptance test 6 is not runnable as written. L1 would catch a
  snapshotted vault by magic regardless, so the reasoning stands and the
  measurement did not.
- **A miscitation of exactly the kind the previous review caught.** Truncation
  was cited at `task.ts:171-173`; the real sites are `DEFAULT_MAX_RESULT_CHARS`
  at `packages/converse/src/task.ts:56` and `truncateChars` at `:202`.
