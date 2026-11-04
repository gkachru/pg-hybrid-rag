-- Row-Level Security for rag_metadata_registry (007 pattern; fail-closed when the GUC is unset).
ALTER TABLE rag_metadata_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY rag_metadata_registry_tenant_isolation ON rag_metadata_registry
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
