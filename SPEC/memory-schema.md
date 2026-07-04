# Northkeep Memory Schema — v0.1

*The open schema for portable, user-owned AI memory.*

*This specification is licensed CC-BY-4.0 so the standard can spread freely,
independent of the Northkeep implementation (which is AGPL-3.0).*

---

## Design principles

1. **Text-canonical.** The durable form of every memory is human-readable
   structured text. Embeddings, indexes, and any other derived data are
   disposable caches — a vault must always be fully reconstructable from its
   text export, and an export must be readable by a human with no tooling.
2. **Provenance on everything.** Every entry records where it came from, when,
   and with what confidence, and participates in a tamper-evident hash chain.
3. **Scoped by default.** Every entry belongs to exactly one scope — the unit
   of selective disclosure and access control.
4. **Time-aware.** Facts change. Entries carry validity windows and are
   superseded, never silently overwritten.

## Memory types

Five types, adopted from the Portable Agent Memory pattern (arXiv:2605.11032):

| Type | Meaning | Example |
|---|---|---|
| `episodic` | Things that happened | "On 2026-06-12 Jay asked about STR financing in Newport" |
| `semantic` | Durable facts | "Jay prefers concise answers without filler" |
| `procedural` | How the user likes things done | "Draft emails in Jay's voice: short, direct, no bullets" |
| `working` | Current active context; ages out | "This week's focus is the M0 vault build" |
| `identity` | Stable profile | "Jay is a compliance professional and EMS lieutenant" |

## Entry fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string (UUID) | yes | Unique, stable identifier |
| `type` | enum (see above) | yes | One of the five memory types |
| `content` | string | yes | The memory itself, natural language |
| `scope` | string | yes | e.g. `personal`, `work`, `client:acme`. Default `personal` |
| `source` | string | yes | Origin: `cli`, `mcp:<client>`, `import:chatgpt`, conversation ref |
| `source_model` | string \| null | no | Model that produced/extracted the entry, if any |
| `confidence` | number 0.0–1.0 | yes | Extraction confidence; `1.0` for user-authored |
| `created_at` | ISO 8601 UTC | yes | When the entry was recorded |
| `valid_from` | ISO 8601 UTC \| null | no | Start of validity window (defaults to `created_at`) |
| `superseded_at` | ISO 8601 UTC \| null | no | When this entry stopped being current |
| `superseded_by` | string (id) \| null | no | Entry that replaced this one |
| `prev_hash` | string (64 hex) | yes | Hash of the previous entry in the chain |
| `entry_hash` | string (64 hex) | yes | This entry's hash (see Hash chain) |
| `metadata` | object \| null | no | Open extension point (JSON object) |

Deletion is real: `forget` removes the entry. The hash chain records that
history existed (subsequent hashes no longer verify against a silently edited
past), but content the user deletes is gone — user ownership beats
append-only purity.

## Hash chain (tamper-evident provenance)

Each entry's `entry_hash` is the BLAKE2b-256 hex digest of the **canonical
JSON** of the entry with `entry_hash` itself omitted:

```
entry_hash = BLAKE2b-256( canonical_json({
  id, type, content, scope, source, source_model, confidence,
  created_at, valid_from, superseded_at, superseded_by, metadata,
  prev_hash
}) )
```

- **Canonical JSON:** keys sorted lexicographically at every level, no
  insignificant whitespace, UTF-8, `null` for absent optional fields.
  Strings are normalized to Unicode NFC before hashing, so
  normalization-changing round-trips don't break the chain. Numbers are
  rendered in ECMAScript `JSON.stringify` form — shortest round-trip decimal,
  no trailing zeros, no exponent for values in ±2⁵³ (so `1.0` renders as `1`).
  Independent implementations MUST match both rules or their hashes will not
  interoperate.
- `prev_hash` of the first entry is 64 zeros (`"0".repeat(64)`).
- The vault stores the current chain head. Verifying the chain = replaying
  hashes over entries ordered by insertion and comparing to the head.
- Hashes live inside the encrypted vault and in exports; they are never
  exposed independently of the content they attest (a bare hash of
  low-entropy content would invite dictionary attacks).

## Scopes

A scope is a lowercase string tag: `personal`, `work`, or namespaced
`client:<name>`, `project:<name>`. v0.1 defines the field and its semantics;
enforcement (per-conversation scope grants) is specified in the security
model and lands at M4. An entry has exactly one scope.

## Embeddings (derived cache — normative)

Implementations MAY maintain an embeddings table keyed by
`(memory_id, embedding_model)`. Embeddings:

- MUST NOT appear in exports,
- MUST NOT be required to open, read, migrate, or rebuild a vault,
- MUST be rebuildable from `content` at any time (e.g. after switching
  embedding models).

## Export format

A vault export is a single JSON document:

```json
{
  "northkeep_export": {
    "schema_version": "0.1",
    "vault_id": "d3b0…",
    "exported_at": "2026-07-04T12:00:00.000Z",
    "chain_head": "9f2c…"
  },
  "memories": [
    {
      "id": "0c9d3a4e-…",
      "type": "semantic",
      "content": "Jay prefers concise answers without filler.",
      "scope": "personal",
      "provenance": {
        "source": "cli",
        "source_model": null,
        "confidence": 1.0,
        "created_at": "2026-07-04T11:58:03.412Z",
        "prev_hash": "0000…",
        "entry_hash": "5b1e…"
      },
      "validity": {
        "valid_from": "2026-07-04T11:58:03.412Z",
        "superseded_at": null,
        "superseded_by": null
      },
      "metadata": null
    }
  ]
}
```

`memories` is ordered by insertion (chain order). The export is complete: a
conforming implementation can rebuild an equivalent vault from it, including
chain verification.

## Versioning

`schema_version` follows `MAJOR.MINOR`. Minor versions only add optional
fields. Anything that changes the meaning or requiredness of an existing
field is a major version and requires a migration note in this spec.
