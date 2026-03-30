CREATE TABLE IF NOT EXISTS rag_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_type VARCHAR(50) NOT NULL,
  source_id UUID,
  chunk_index VARCHAR(50) NOT NULL DEFAULT '0',
  content TEXT NOT NULL,
  content_stemmed TEXT,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  embedding vector(384) NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_tenant ON rag_documents (tenant_id);
