CREATE TABLE IF NOT EXISTS rag_stop_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  language VARCHAR(10) NOT NULL,
  word VARCHAR(100) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rag_stop_words_tenant ON rag_stop_words (tenant_id);
