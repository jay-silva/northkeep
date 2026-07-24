# ADR 0025: Mobile on-device models (private chat and Tier-2 redaction)

- **Date:** 2026-07-16
- **Status:** Proposed. Entirely device-gated; NOTHING here has been validated on
  hardware. No on-device model code ships until the leak-corpus evaluation
  (below) is run on a real device and its result selects one of the three
  outcomes. This ADR fixes the interface and the gating rule; it does not
  authorize shipping Tier-2-on-phone.
- **Deciders:** Jay, Claude Code

## Context

Two mobile capabilities need a model that runs entirely on the phone, with no
network:

1. **Absolute-privacy chat.** Converse with the vault in airplane mode, nothing
   leaving the device at all (stronger than the BYOK-plus-Tier-1 cloud path,
   which does send a redacted payload to the chosen provider).
2. **Tier-2 redaction on the phone.** The desktop runs a second, model-based
   redaction tier (NER-style entity detection) on top of the deterministic
   Tier-1 rules, via loopback Ollama. The phone has no Ollama. Without an
   on-device model, the phone can only offer Tier-1 as its guaranteed floor, and
   invariant #6 requires saying so loudly rather than pretending Tier-2 ran.

The desktop already treats models behind an interface (the Embedder seam in
packages/core, and the extraction model in packages/librarian degrade loudly
when Ollama is absent). Mobile needs the same shape for a chat/NER model.

## Decision

### A LocalModel interface, two implementations

Define a `LocalModel` interface (text generation, streaming, and structured
output for the NER use) that the Converse pipeline and the redaction pipeline
depend on, never a concrete model. Two implementations:

- **AppleFMModel (primary, iOS).** Apple Foundation Models framework bridged via
  @react-native-ai/apple. It provides on-device text generation, streaming, and
  structured output constrained by a schema (a good fit for Tier-2 entity
  extraction), plus NLContextualEmbedding for optional on-device semantic search.
  It requires iOS 26+ on an iPhone 15 Pro or later; on anything older or on
  Android it is simply unavailable and the app must fall back or degrade.
- **LlamaRnModel (fallback and Android baseline).** llama.rn (llama.cpp) running
  a small GGUF model. This is the path when Apple FM is unavailable. The GGUF is
  downloaded after install (roughly 1 GB for a 1B model, roughly 2 GB for a 3B
  Q4), which is a NEW networked dependency and therefore needs its own ADR and
  Jay's explicit OK before it ships (invariant #7). The download endpoint, its
  integrity check, and its host are out of scope here and are flagged as a
  prerequisite, not decided.

When neither is available, there is no Tier-2 and no private chat, and the app
shows the loud persistent degradation banner (invariant #6): Tier-1 remains the
guaranteed redaction floor, and cloud Converse stays available behind it.

### Tier-2-on-phone ships only if it passes the leak-corpus evaluation

Tier-2 is a privacy control, so it may not ship on vibes. The gate is the same
seeded-secrets leak corpus the CI leak test uses on desktop: run the corpus
through the on-device model's entity detection and count misses against the
desktop Tier-2 baseline. The result selects exactly one outcome:

- **Parity (misses at or below desktop Tier-2):** ship Tier-2-on-phone as a
  first-class, active tier.
- **Near (slightly worse but clearly better than Tier-1 alone):** ship it, but
  label it "beta" in the UI so the user knows the on-device tier is not yet at
  desktop strength.
- **Poor (meaningfully worse):** do NOT use it for redaction at all. The model is
  still allowed for the airplane-mode private-chat use (where nothing leaves the
  device, so a redaction miss cannot leak anything), and Tier-2 for cloud
  Converse waits. Tier-1 stays the loud floor.

This keeps the privacy promise honest: the phone never claims a redaction
strength it did not measure, and it never silently downgrades a tier.

### Airplane-mode private chat

Private chat routes vault retrieval and generation entirely through the
LocalModel with no network call. Because nothing leaves the device, this mode is
safe to offer even when the model is too weak for Tier-2 redaction. It is also
the strongest privacy story in the product: memory in, answer out, on one device,
offline.

### Embeddings stay disposable cache (invariant #4)

If NLContextualEmbedding (or any on-device embedder) is used for semantic search,
its vectors go in the existing embeddings cache table, keyed by (memory_id,
model), so mobile vectors coexist with desktop nomic-embed-text vectors without
collision. They are disposable cache: never exported, never part of any hash or
the provenance chain, safe to drop and regenerate (invariant #4). No memory
schema change.

## Alternatives considered

- **Cloud model for everything (no on-device model).** Rejected: it forecloses
  airplane-mode private chat entirely and forces every Converse turn through a
  provider, losing the strongest privacy mode and making Tier-2 depend on a
  network round trip.
- **Ship Tier-2-on-phone unconditionally.** Rejected: an unmeasured redaction
  tier is a privacy claim we cannot stand behind; the leak-corpus gate is
  non-negotiable.
- **Bundle the GGUF in the app binary.** Rejected: it would bloat the download by
  1 to 2 GB and still needs updating out of band; post-install download is the
  norm for llama.rn, at the cost of a new networked dependency to be approved
  separately.
- **ML Kit GenAI (Gemini Nano) as the Android primary.** Noted as a possible
  Android enhancement on Pixel 8+/S24-class devices, not decided here; llama.rn
  is the Android baseline.

## Needs on-device validation / adversarial review before merge

1. The leak-corpus evaluation actually run on a real iPhone 15 Pro (Apple FM) and
   on the llama.rn fallback, producing the miss counts that select parity / near
   / poor. Until then no on-device redaction ships.
2. Confirmation that @react-native-ai/apple exposes the structured-output and
   streaming surface the LocalModel interface assumes, on the target iOS 26
   device.
3. A separate ADR plus Jay's explicit OK for the GGUF download endpoint (new
   networked dependency, invariant #7), including host, integrity verification,
   and size/network handling, before LlamaRnModel ships.
4. Device measurement of model memory footprint and latency alongside the
   Argon2id unlock cost (ADR 0023), so the two heavy on-device workloads are
   known not to collide on older hardware.
5. If Tier-2-on-phone is used for redaction, the invariant-#6 UI states (active,
   beta, unavailable) reviewed so the user is never misled about which tier ran.

## Implementation status (M6-4 foundation, 2026-07-17)

Landed on a PARALLEL branch (not track-m). Requires an EAS rebuild + a capable
device before it is real; the lead decides when to merge. What is in place:

- **LocalModel seam** in `packages/platform-mobile/src/local-model/`: the
  `LocalModel` interface (`generateText`, `generateStructured`, `isReady`),
  `AppleFMModel` (primary), `LlamaRnModel` (fallback), `detectLocalModel`
  (Apple-first, degrades to `none`), and `createLocalNerClient` (adapts a
  LocalModel to the desktop `OllamaClient` shape so `packages/redact` applyTier2
  runs UNCHANGED). Exposed via subpath `@northkeep/platform-mobile/dist/local-model/*`
  (kept off the package barrel so Node consumers do not load native modules).
- **Tier-2 on device**: `runMobileTurn` upgrades a cloud turn to Tier-2 when a
  ready LocalModel is present (a redactFn bound to the on-device NER client);
  otherwise Tier-1 remains the floor. On a mid-turn model failure the existing
  runTurn abort path fires (loud, invariant #6).
- **On-device provider**: `runOnDeviceTurn` + `createLocalModelProvider` run
  Converse fully offline; a localhost sentinel URL makes runTurn classify the
  endpoint `private` (tier 0, no egress).
- **Leak-corpus eval GATE**: `packages/redact/src/eval.ts` (`evaluateNer` +
  seeded synthetic `NER_EVAL_CORPUS`) scores strict NER recall (whole span +
  correct kind, partial catches are misses) from the structured Tier-2 output,
  and re-checks the Tier-1 secret floor. The SAME function scores the desktop
  Ollama baseline and the on-device model, so parity is comparable. Device runner:
  `apps/mobile/src/lib/local-eval.ts` (`runOnDeviceNerEval`). Harness logic is
  unit-tested (perfect / partial / wrong-kind / no-model fakes).

### Verified empirically (July 2026)

- `@react-native-ai/apple@0.12.0` (peer `react-native >=0.76`; needs iOS 26+ with
  Apple Intelligence hardware; AI-SDK-based, `apple.isAvailable()`, guided
  generation via `Output`/`generateObject`). Compatible with SDK 55 / RN 0.83 /
  New Arch on paper.
- `ai@^6` (Vercel AI SDK; `@ai-sdk/provider@3.x`, matches the apple provider) is
  a NEW JS dependency required to drive `@react-native-ai/apple`.
- `expo export --platform ios` bundles cleanly. Mobile typecheck and all 440
  monorepo unit tests stay green.

### llama.rn DE-LINKED for the Apple-FM-only build (2026-07-17)

EAS build 4 failed with `XCODE_BUILD_ERROR: 'rnllama/rn-llama.h' file not found`.
The `llama.rn` native iOS integration does not resolve under Expo + New
Architecture: the CocoaPods header search path is broken (and skipping its build
script, which `pnpm -r build` needs, means the native prep never runs). This is a
REAL, UNRESOLVED native-integration problem.

It is NOT on the critical path: Jay tests on an iPhone 17 Pro Max, which uses the
Apple Foundation Models backend, not llama. llama is only the older-device
fallback. So for build 4:

- `llama.rn` is removed from `apps/mobile/package.json`, from the
  `pnpm-workspace.yaml allowBuilds` map, and there is no app.config.ts plugin.
- `LlamaRnModel` is now an IMPORT-FREE stub (`isReady()` returns false, generate
  methods throw). Nothing `import`s `llama.rn`, so Xcode never tries to compile
  it. `detectLocalModel` therefore resolves to Apple-or-none.
- `AppleFMModel`, the `LocalModel` interface, Tier-2-on-device, the on-device
  private provider, and the eval harness are all intact and unchanged.

WEEKEND FOLLOW-UP (needs a non-Apple-Intelligence device to test anyway): fix the
rn-llama.h / pod header search path under New Arch (or switch to a maintained fork
/ prebuilt xcframework), then restore the real implementation preserved in git at
commit ca4e812 (`packages/platform-mobile/src/local-model/llama-rn.ts`). The llama
GGUF DOWNLOAD also remains a separate networked dependency needing Jay's explicit
OK (item 3 above) before it ships.

### Remaining new dependencies (need the standing ADR note + an EAS rebuild)

`@react-native-ai/apple`, `ai`. Both on-device / no network at inference time, so
invariant #7's network trigger does not apply to inference.

### Still needed to make M6-4 real

- Run `runOnDeviceNerEval` on Apple FM hardware (iPhone 15 Pro or newer); the
  recall number selects parity / beta / private-chat-only. The llama GGUF arm of
  the eval is blocked on the native-integration fix above.
- Capture the desktop Ollama baseline with the same `evaluateNer` for comparison.
- UI: on-device provider entry in the Converse picker; replace the fixed
  "Tier-1 only" banner with the three invariant-#6 states; and label the
  on-device turn's "What left this device" view as "stayed on device, nothing
  egressed" (it captures a tier-0 PLAINTEXT prompt, which must not read as a send).
- Device-verify the actual `@react-native-ai/apple` / `llama.rn` / `ai` runtime
  APIs against the adapters (written from published docs/types, not yet run).
