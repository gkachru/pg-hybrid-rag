CREATE TABLE IF NOT EXISTS rag_synonyms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  language VARCHAR(10) NOT NULL,
  term VARCHAR(255) NOT NULL,
  synonyms JSONB NOT NULL,
  direction VARCHAR(10) NOT NULL DEFAULT 'two_way',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_synonyms_tenant ON rag_synonyms (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_synonyms_tenant_term_lang ON rag_synonyms (tenant_id, term, language);
