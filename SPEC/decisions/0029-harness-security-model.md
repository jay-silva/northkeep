# ADR 0029: The harness security model — permission engine and exfiltration screens

- **Date:** 2026-07-24
- **Status:** Accepted
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0027 (the agentic harness umbrella); companion to ADR 0028

## Context

M10b shipped the agent loop with a deliberately dumb gate: every tool call
asks, every time. Two promises were made for M10c and this ADR delivers both:

1. **A real permission engine.** Ask-everything is safe but exhausting, and
   permission fatigue is itself a security failure: a user trained to hit
   "y" on every prompt stops reading the prompts. The engine must let the
   user grant trust narrowly (this tool, this exact site) without ever
   creating a quiet blanket permission.
2. **Exfiltration screens over decoded arguments.** The M10b adversarial
   review (G2) confirmed the Tier-1 egress floor is a literal-string
   matcher: a secret that is percent-encoded, base64-encoded, or split by
   punctuation slips past it and decodes at the destination. KNOWN-LIMITS
   has stated since M10b that the M10c engine screens the DECODED and
   normalized URL components plus vault-content and pseudonym real-values.
   The threat is concrete: a prompt-injected model paraphrases the user's
   context into its next tool-call URL, encoded so the approval prompt looks
   innocent at a glance.

## Decision 1: enforcement lives in the loop, policy lives in the gate

The exfiltration screens run inside `runTask` itself, before the gate is
consulted, on the RESTORED plaintext arguments (what would actually
execute). They do not live inside any `PermissionGate` implementation.
Rationale: the gate is an injectable seam (the CLI wires the real engine, a
test wires a stub, M10e's web GUI wires its own) — and an injectable seam is
exactly where a security control must NOT live, because a surface that wires
a permissive gate would silently lose the screens. The same argument put the
SSRF guard inside the net client (ADR 0028), not in the tool.

The division of labor:

- **Loop (task.ts):** runs `screenArguments` (exfil.ts) on every tool call;
  hard-denies secret-class hits before the gate ever sees the call; passes
  `screened: true` to the gate and the flag descriptions to the approval
  surface for everything else.
- **Gate (policy.ts engine):** decides auto-allow / ask / deny from grants,
  risk class, and the screened bit. Never sees argument content — it decides
  from (tool, host, risk, screened) only, which keeps the policy engine
  auditable and keeps content out of any future policy store.

## Decision 2: the screens (exfil.ts)

Every tool call's restored arguments are decomposed and screened:

- **Decomposition:** the egress URL is split into host, path segments, query
  keys and values, and fragment; every string leaf of the argument JSON is
  screened as body. Unparseable URLs or JSON are screened whole (fail
  closed — malformed input never skips the screen).
- **Decoding:** each component is percent-decoded up to three rounds
  (double-encoding is a classic reviewer-evasion; three rounds catches
  triple encoding, and the bound prevents decode-bomb loops). Components
  that look like base64/base64url (charset-valid, ≥ 16 chars) are decoded
  and screened too when the result is mostly printable, including one
  further percent-decode of the decoded text. Matching normalizes case and
  strips punctuation, so `1-2-3` splits and `%2D` games do not evade.
- **Three detector classes:**
  - `secret` — the deterministic Tier-1 detectors (SSN, card, API key
    shapes) run over every raw and decoded component.
  - `identity` — the session's pseudonym real-values (the names Tier-2/3
    redaction is actively protecting in this conversation) as normalized
    substrings.
  - `memory` — normalized 16-gram overlap between components and the
    content of vault memories disclosed to the model THIS task. This is the
    paraphrase-exfiltration screen: if the model tries to smuggle what it
    just read from the vault into a URL, the overlap trips regardless of
    encoding.
- The URL **host** is screened for secrets only, not identity/memory: the
  user who says "fetch carolmansfield.com" named that host on purpose, the
  host is shown verbatim at every approval prompt, and a host-level identity
  match would be a constant false positive.

Screen outcomes, in order of severity:

- **High-severity secrets (SSN, card, IBAN, API key) → hard deny, loudly.**
  These kinds have no legitimate reason to ride an egress URL and are
  catastrophic if leaked. The call never executes and never reaches the
  gate; the model receives structured `{error: 'blocked_exfiltration'}`
  guidance; the user sees a denial event with the content-free reason; the
  audit row records the flag kinds. This is the one place the harness
  denies without asking: a URL carrying an SSN off the machine is never
  something to approve at a glance, and invariant #6's "loud" is satisfied
  by the visible denial with reason — silent would be dropping the call
  without a trace.
- **Everything else → always ask, with warnings.** Lower-severity secret
  kinds (email, phone, record ids, addresses), protected names, and memory
  overlap all have legitimate uses (the user may WANT the model to search
  their own email) and false positives, so the screen escalates rather
  than blocks: grants are ignored (`screened` calls never auto-allow) and
  the approval prompt shows each flag as a plain sentence ("this request
  appears to include content from your vault memories, hidden by
  encoding"). The human decides. Widening the hard-deny set is cheap;
  narrowing it requires a review.

Flags are content-free by construction: class, kind, region, and whether
decoding was needed — never the matched text, so warning lines and audit
rows stay clean.

## Decision 3: the permission engine (policy.ts)

Consent vocabulary, offered at the approval prompt by the driving surface:

- **yes once** — this call only (M10b behavior).
- **this session** — auto-allow (tool, exact host) until the process exits.
- **always** — persisted grant in `~/.northkeep/permissions.json`.
- **no** — this call only.
- **never** — persisted deny for (tool, exact host); future calls refuse
  without prompting.

Engine decision order: `never` grant → deny; `consequential` risk → ask
(state-changing tools never auto-allow in v1, grants notwithstanding);
`screened` → ask; session or `always` grant → auto-allow; otherwise ask.

Grant matching is exact-host, case-insensitive, with NO wildcards and NO
subdomain inheritance — a grant for `example.com` does not cover
`api.example.com`. Subdomain trust is not transitive, and a wildcard grant
is precisely the quiet blanket permission this product refuses to create.
Per-tool, so a future `web_search` grant says nothing about `web_fetch`.

The file follows the registry.ts idiom: 0600, versioned, tolerant loader
where anything malformed is IGNORED (a corrupt grants file yields no grants
— fail closed into asking, never into allowing). Grants are visible and
reversible from the CLI (`northkeep tools grants`, `northkeep tools
revoke`), honoring the product rule that consent is inspectable and
revocable. There is deliberately no `tools grant` command: a grant is
created only at a live approval prompt where the user is looking at the
exact call, never sight-unseen.

The default engine (`createPermissionEngine()`) is memory-only; only a
surface that explicitly opts in (`persist: true` — the CLI does) reads or
writes the grants file. A library call must not write config as a side
effect. `runTask`'s default gate remains fail-closed.

## Decision 4: audit and events

Every tool-call audit row (content-free, ADR 0028) additionally records the
decision's provenance: the scope the user chose (`once`/`session`/`always`/
`never`) or `auto` (grant satisfied it) — and the screen flags when any
fired, as compact descriptors (`secret:ssn:query:decoded`). The permission
TaskEvent carries the same, so the CLI can render "auto-allowed (site
grant)" and denial reasons honestly. What is deliberately NOT recorded:
matched values, argument text, or anything recoverable.

## Honest limits (mirrored in KNOWN-LIMITS.md)

- The screens are syntactic. SEMANTIC paraphrase ("the user is a paramedic
  in Massachusetts" reworded into novel words) shares no 16-gram with the
  vault text and passes clean. The approval prompt showing the exact URL
  remains the real backstop, and the fence discipline (ADR 0028 decision 5)
  remains the first line.
- Decoding is bounded and enumerable: percent (3 rounds) and base64. A
  novel encoding the model invents (ROT13, custom substitution) is not
  decoded; it is partially mitigated by the memory screen running over the
  RAW component too, and by tier-1 masking having removed verbatim secrets
  from what a bounded model ever saw.
- `never`/`always` grants key on (tool, host) — a granted host that later
  starts redirecting elsewhere is caught by the net client's per-hop
  re-validation, but a granted host serving different CONTENT than when
  trust was given is invisible to the engine.
- Session grants die with the process; memory-only `always` grants (the
  non-persisting default engine) degrade to session semantics by design.

## Consequences

- Permission fatigue drops without any quiet widening of trust: every
  auto-allow traces to an explicit, named, revocable user grant.
- The G2 encoding-evasion gap is closed at the decode depth stated above,
  and the paraphrase-exfiltration channel named in KNOWN-LIMITS now has an
  active screen, not just a prompt.
- M10d's web_search and M10e's GUI approval surface slot into the same
  engine and the same screens with zero new security machinery.
