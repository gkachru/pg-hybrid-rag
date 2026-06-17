-- GIN index for keyword search via pg_trgm.
-- The keyword leg uses the word-similarity operator (`$2 <% content`) so this index applies;
-- gin_trgm_ops cannot accelerate a bare word_similarity(a, b) > threshold function comparison.
CREATE INDEX IF NOT EXISTS idx_rag_content_trgm
  ON rag_documents USING GIN (content gin_trgm_ops);

-- IVFFlat index for vector search.
-- `lists` is a corpus-size tuning knob (rule of thumb: rows/1000 up to ~1M rows, then sqrt(rows));
-- 100 suits small/medium corpora. The vector leg sets `ivfflat.probes` per query (default 10 via
-- PostgresRagDatabase) — probes default to 1, which scans a single list and hurts recall. For
-- recall-sensitive deployments prefer the migration-010 vchordrq index.
CREATE INDEX IF NOT EXISTS idx_rag_embedding_ivfflat
  ON rag_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- NOTE: the former idx_rag_content_stemmed_trgm index was removed — content_stemmed is unused
-- since migration 008 (see migration 012, which drops the index and the column on upgrades).
