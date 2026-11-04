-- Integrator-maintained registry of metadata keys: descriptions and allowed values that the
-- tenant catalog merges with keys observed in rag_documents.attributes.
CREATE TABLE IF NOT EXISTS rag_metadata_registry (
  tenant_id      UUID        NOT NULL,
  ns             TEXT        NOT NULL,
  key            TEXT        NOT NULL,
  description    TEXT        NOT NULL,
  type           TEXT,
  format         TEXT,
  multi          BOOLEAN,
  allowed_values JSONB,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, ns, key)
);
