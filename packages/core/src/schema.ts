/** SQLite DDL implementing SPEC/memory-schema.md v0.1. */
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
  prev_hash     TEXT NOT NULL,
  entry_hash    TEXT NOT NULL,
  metadata      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_type  ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);

-- DISPOSABLE CACHE (spec invariant): never exported, never required to
-- open, read, migrate, or rebuild a vault. Populated from M1+ via sqlite-vec.
CREATE TABLE IF NOT EXISTS embeddings (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,
  dims      INTEGER NOT NULL,
  vector    BLOB NOT NULL,
  PRIMARY KEY (memory_id, model)
);

CREATE TABLE IF NOT EXISTS vault_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
