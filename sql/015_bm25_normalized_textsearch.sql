-- Rebuild the pg_textsearch BM25 indexes on content_normalized instead of raw content
-- (optional — applied with ragMigrate(client, { bm25: true })).
-- PREREQUISITE (ops): shared_preload_libraries includes 'pg_textsearch' + Postgres restart.
--
-- Migration 013 moved the keyword (pg_trgm) leg and the tsvector FTS source onto the
-- orthographically-normalized column; the BM25 leg was the last lexical leg still matching raw
-- `content`, so a normalized query (e.g. Arabic taa-marbuta/alef folds) could not match it. This
-- realigns BM25 with the other lexical legs. Index names are unchanged (Bm25Fts references them by
-- name); only the indexed column changes, so we DROP + CREATE. Predicates/configs mirror sql/011
-- exactly (kept in sync with BM25_LANGUAGE_GROUPS by a test). Raw `content` is still stored for
-- display + dense embedding. content_normalized is backfilled (013) and always written by
-- RagIndexer, so — like the pg_trgm leg — the index needs no COALESCE fallback.
DROP INDEX IF EXISTS idx_rag_bm25_en;
CREATE INDEX IF NOT EXISTS idx_rag_bm25_en ON rag_documents USING bm25(content_normalized)
  WITH (text_config='english')    WHERE language IN ('en','en-US','en-IN');

DROP INDEX IF EXISTS idx_rag_bm25_es;
CREATE INDEX IF NOT EXISTS idx_rag_bm25_es ON rag_documents USING bm25(content_normalized)
  WITH (text_config='spanish')    WHERE language IN ('es','es-ES','es-MX');

DROP INDEX IF EXISTS idx_rag_bm25_fr;
CREATE INDEX IF NOT EXISTS idx_rag_bm25_fr ON rag_documents USING bm25(content_normalized)
  WITH (text_config='french')     WHERE language IN ('fr','fr-FR');

DROP INDEX IF EXISTS idx_rag_bm25_de;
CREATE INDEX IF NOT EXISTS idx_rag_bm25_de ON rag_documents USING bm25(content_normalized)
  WITH (text_config='german')     WHERE language IN ('de','de-DE');

DROP INDEX IF EXISTS idx_rag_bm25_it;
CREATE INDEX IF NOT EXISTS idx_rag_bm25_it ON rag_documents USING bm25(content_normalized)
  WITH (text_config='italian')    WHERE language IN ('it','it-IT');

DROP INDEX IF EXISTS idx_rag_bm25_pt;
CREATE INDEX IF NOT EXISTS idx_rag_bm25_pt ON rag_documents USING bm25(content_normalized)
  WITH (text_config='portuguese') WHERE language IN ('pt','pt-PT');

DROP INDEX IF EXISTS idx_rag_bm25_ro;
CREATE INDEX IF NOT EXISTS idx_rag_bm25_ro ON rag_documents USING bm25(content_normalized)
  WITH (text_config='romanian')   WHERE language IN ('ro','ro-RO');

-- Catch-all for unsupported languages (no stemming).
DROP INDEX IF EXISTS idx_rag_bm25_simple;
CREATE INDEX IF NOT EXISTS idx_rag_bm25_simple ON rag_documents USING bm25(content_normalized)
  WITH (text_config='simple')
  WHERE language NOT IN ('en','en-US','en-IN','es','es-ES','es-MX','fr','fr-FR','de','de-DE','it','it-IT','pt','pt-PT','ro','ro-RO');
