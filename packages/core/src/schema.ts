/** SQLite DDL implementing SPEC/memory-schema.md v0.4.
 * vault_meta stays key/value TEXT; sync_generation is stored as a decimal
 * integer string (ADR 0038 addendum). */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN
                ('episodic','semantic','procedural','working','identity')),
  content       TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'personal',
  source        TEXT NOT NULL,
  source_model  TEXT,
  confidence    REAL NOT NULL DEFAULT 1.0
                CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at    TEXT NOT NULL,
  valid_from    TEXT,
  superseded_at TEXT,
  superseded_by TEXT REFERENCES memories(id),
  forgotten_at  TEXT,
  prev_hash     TEXT NOT NULL,
  entry_hash    TEXT NOT NULL,
  metadata      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_type  ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);

-- No embeddings table (ADR 0067): vectors are a RAM-only cache, so the synced
-- image never carries them. Vaults made before 0067 have one; save() drops it.

CREATE TABLE IF NOT EXISTS vault_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-scope sharing state (ADR 0038, schema 0.3). Inside the vault so it syncs
-- with the vault: a scope marked Shared on one device is Shared on all of them.
-- Default private is structural: no row (or shared = 0) means private, and a
-- fresh migration creates this table EMPTY.
CREATE TABLE IF NOT EXISTS scopes (
  scope     TEXT PRIMARY KEY,
  shared    INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  shared_at TEXT
);
`;
