-- Row-Level Security for rag_documents
-- 2-arg current_setting(name, true): a connection that never set the GUC gets NULL -> matches zero
-- rows (fail-closed) instead of erroring "unrecognized configuration parameter". The caching
-- stop-word/synonym loaders and any health check/middleware that miss the SET get an empty result.
ALTER TABLE rag_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY rag_documents_tenant_isolation ON rag_documents
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Row-Level Security for rag_stop_words
ALTER TABLE rag_stop_words ENABLE ROW LEVEL SECURITY;

CREATE POLICY rag_stop_words_tenant_isolation ON rag_stop_words
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Row-Level Security for rag_synonyms
ALTER TABLE rag_synonyms ENABLE ROW LEVEL SECURITY;

CREATE POLICY rag_synonyms_tenant_isolation ON rag_synonyms
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
