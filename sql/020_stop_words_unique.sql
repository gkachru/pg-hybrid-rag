-- One row per (tenant_id, language, word) in rag_stop_words. The table had no unique constraint,
-- so the same stop word could be inserted twice. Remove existing duplicates (keeping one row of
-- each), then enforce uniqueness so `INSERT ... ON CONFLICT DO NOTHING` works for seeding.
-- Matching is exact: 'The' and 'the' stay separate rows (the loader lowercases both at load).
DELETE FROM rag_stop_words a
USING rag_stop_words b
WHERE a.tenant_id = b.tenant_id
  AND a.language = b.language
  AND a.word = b.word
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_stop_words_tenant_lang_word
  ON rag_stop_words (tenant_id, language, word);
