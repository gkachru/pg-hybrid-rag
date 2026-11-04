-- Typed, namespaced per-article attributes (spec §6.4).
-- Stored as a JSONB array of entries on every chunk row of an article. The GIN jsonb_path_ops
-- index serves containment (@>) lookups.
--
-- No backfill: existing rows get '[]'. Legacy rows therefore match `not` / `exists: false`
-- conditions and no positive condition (they have no attributes to match).

ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_rag_attributes ON rag_documents USING gin (attributes jsonb_path_ops);
