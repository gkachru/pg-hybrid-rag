-- VectorChord vchordrq vector index (optional — apply with ragMigrate(client, { vectorchord: true })).
-- PREREQUISITE (ops, not in this migration): shared_preload_libraries = 'vchord' + Postgres restart.
-- Swaps the IVFFlat index for vchordrq. Queries are unchanged (same <=> operator).
CREATE EXTENSION IF NOT EXISTS vchord CASCADE;
DROP INDEX IF EXISTS idx_rag_embedding_ivfflat;
CREATE INDEX IF NOT EXISTS idx_rag_embedding_vchordrq
  ON rag_documents USING vchordrq (embedding vector_cosine_ops);
