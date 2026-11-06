-- Apply the tenant policies (007, 019) to the table owner too. Without FORCE, Postgres exempts a
-- table's owner from its own RLS policies, so an application that connects as the role that ran
-- the migrations saw every tenant's rows. Superusers and roles with BYPASSRLS are still exempt.
--
-- Applied only with { rls: true }. After this migration, the owner must set app.current_tenant_id
-- like any other role; without it, queries on these tables return no rows.
--
-- NOTE FOR FUTURE MIGRATIONS: a data migration (UPDATE/DELETE backfill) on these tables run by a
-- non-superuser owner now sees only rows of the tenant in app.current_tenant_id (none when unset).
-- Such a migration must lift FORCE for its own transaction and restore it only where it was set:
--   DO $do$ DECLARE forced boolean; BEGIN
--     SELECT relforcerowsecurity INTO forced FROM pg_class WHERE oid = 'rag_documents'::regclass;
--     ALTER TABLE rag_documents NO FORCE ROW LEVEL SECURITY;
--     UPDATE rag_documents SET ...;
--     IF forced THEN ALTER TABLE rag_documents FORCE ROW LEVEL SECURITY; END IF;
--   END $do$;
-- NO FORCE restores the owner's exemption, so the backfill sees every row; the IF puts FORCE back.
ALTER TABLE rag_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE rag_stop_words FORCE ROW LEVEL SECURITY;
ALTER TABLE rag_synonyms FORCE ROW LEVEL SECURITY;
ALTER TABLE rag_metadata_registry FORCE ROW LEVEL SECURITY;
