-- GIN index for keyword search via pg_trgm
CREATE INDEX IF NOT EXISTS idx_rag_content_trgm
  ON rag_documents USING GIN (content gin_trgm_ops);

-- IVFFlat index for vector search
CREATE INDEX IF NOT EXISTS idx_rag_embedding_ivfflat
  ON rag_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- GIN index for stemmed content keyword search
CREATE INDEX IF NOT EXISTS idx_rag_content_stemmed_trgm
  ON rag_documents USING GIN (content_stemmed gin_trgm_ops);
