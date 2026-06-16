-- pg_textsearch BM25 indexes (optional — apply with ragMigrate(client, { bm25: true })).
-- PREREQUISITE (ops): shared_preload_libraries includes 'pg_textsearch' + Postgres restart.
-- Coexists with the tsvector column/trigger; selectable per deployment via the fts strategy.
CREATE EXTENSION IF NOT EXISTS pg_textsearch;

-- One partial BM25 index per language group (literals mirror BM25_LANGUAGE_GROUPS).
CREATE INDEX IF NOT EXISTS idx_rag_bm25_en ON rag_documents USING bm25(content)
  WITH (text_config='english')    WHERE language IN ('en','en-US','en-IN');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_es ON rag_documents USING bm25(content)
  WITH (text_config='spanish')    WHERE language IN ('es','es-ES','es-MX');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_fr ON rag_documents USING bm25(content)
  WITH (text_config='french')     WHERE language IN ('fr','fr-FR');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_de ON rag_documents USING bm25(content)
  WITH (text_config='german')     WHERE language IN ('de','de-DE');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_it ON rag_documents USING bm25(content)
  WITH (text_config='italian')    WHERE language IN ('it','it-IT');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_pt ON rag_documents USING bm25(content)
  WITH (text_config='portuguese') WHERE language IN ('pt','pt-PT');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_ro ON rag_documents USING bm25(content)
  WITH (text_config='romanian')   WHERE language IN ('ro','ro-RO');

-- Catch-all for unsupported languages (no stemming).
CREATE INDEX IF NOT EXISTS idx_rag_bm25_simple ON rag_documents USING bm25(content)
  WITH (text_config='simple')
  WHERE language NOT IN ('en','en-US','en-IN','es','es-ES','es-MX','fr','fr-FR','de','de-DE','it','it-IT','pt','pt-PT','ro','ro-RO');

-- idx_rag_tenant (migration 002) already provides the B-tree pre-filter pg_textsearch uses.
