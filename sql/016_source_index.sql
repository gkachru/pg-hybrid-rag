-- Composite index for the source-scoped delete/replace path.
-- replaceSource and deleteBySource both filter on (tenant_id, source_type, source_id) with
-- equality. Until now only idx_rag_tenant (migration 002) existed, so a re-index (DELETE the
-- source's rows, then INSERT the new ones) scanned EVERY row of the tenant and filtered by
-- source — O(tenant rows) work on every index() call. This composite btree turns it into an
-- index range scan over just the source's chunks.
--
-- Column order matches the predicate's selectivity progression (tenant -> type -> id) and the
-- leading column keeps this index usable for tenant-only lookups too. idx_rag_tenant is RETAINED:
-- it is the narrower index the pg_textsearch BM25 pre-filter and RLS tenant checks rely on
-- (migration 011's note), and dropping it is out of scope for this performance fix.
--
-- NOTE: for large existing deployments, build this CONCURRENTLY out-of-band BEFORE running the
-- migration (CREATE INDEX CONCURRENTLY cannot run inside the migration's transaction); the
-- IF NOT EXISTS below then no-ops.
CREATE INDEX IF NOT EXISTS idx_rag_source
  ON rag_documents (tenant_id, source_type, source_id);
