-- pg_bigm extension for CJK (Chinese, Japanese, Korean) keyword search
-- Bigram similarity works on character pairs regardless of word boundaries,
-- making it effective for scripts without whitespace tokenization.
CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- GIN index using bigram ops for CJK content
CREATE INDEX IF NOT EXISTS idx_rag_content_bigm
  ON rag_documents USING GIN (content gin_bigm_ops);
