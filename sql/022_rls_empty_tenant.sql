-- Treat an EMPTY app.current_tenant_id like an unset one. Applied only with { rls: true }.
--
-- current_setting('app.current_tenant_id', true) returns NULL in a session that never set the
-- variable, but '' in a session where an earlier transaction set it with set_config(..., true)
-- and has since ended (or after RESET). The 007/019 policies cast that '' to uuid and raised
-- "invalid input syntax for type uuid", so on a pooled connection a query that skipped setting
-- the tenant failed or returned zero rows depending on the connection's history. NULLIF maps ''
-- to NULL, so both cases match zero rows (fail-closed, no error).
--
-- The policies are recreated by name, which also replaces the older single-argument form that the
-- 007 header describes. A custom policy with one of these names is replaced too.
DROP POLICY IF EXISTS rag_documents_tenant_isolation ON rag_documents;
CREATE POLICY rag_documents_tenant_isolation ON rag_documents
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS rag_stop_words_tenant_isolation ON rag_stop_words;
CREATE POLICY rag_stop_words_tenant_isolation ON rag_stop_words
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS rag_synonyms_tenant_isolation ON rag_synonyms;
CREATE POLICY rag_synonyms_tenant_isolation ON rag_synonyms
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS rag_metadata_registry_tenant_isolation ON rag_metadata_registry;
CREATE POLICY rag_metadata_registry_tenant_isolation ON rag_metadata_registry
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
