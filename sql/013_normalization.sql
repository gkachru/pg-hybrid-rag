-- content_normalized: app-populated orthographic-normalized text feeding the LEXICAL legs.
-- Plain nullable column (ADD is instant, metadata-only) — populated by RagIndexer, exactly like
-- the embedding column. Raw `content` is kept for display + dense embedding.
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS content_normalized TEXT;

-- Identity backfill for existing rows so the lexical legs keep working immediately. Arabic rows
-- only gain orthographic folding after they are re-indexed with a Normalizer.
UPDATE rag_documents SET content_normalized = content WHERE content_normalized IS NULL;

-- Move the pg_trgm GIN index onto the normalized column (the keyword leg now matches it).
-- NOTE: for large existing deployments, build this CONCURRENTLY out-of-band BEFORE running the
-- migration (CREATE INDEX CONCURRENTLY cannot run inside the migration's transaction); the
-- IF NOT EXISTS below then no-ops.
CREATE INDEX IF NOT EXISTS idx_rag_content_normalized_trgm
  ON rag_documents USING GIN (content_normalized gin_trgm_ops);

DROP INDEX IF EXISTS idx_rag_content_trgm;
