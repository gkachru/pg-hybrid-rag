-- Drop the dead trigram index on content_stemmed.
-- content_stemmed has been unused since migration 008 (Postgres now stems via the
-- content_tsvector trigger; app-level stemming via content_stemmed was retired). insertChunks
-- never writes the column, so it is always NULL and idx_rag_content_stemmed_trgm indexes only
-- NULLs — pure write-time and storage overhead that can never match a query.
DROP INDEX IF EXISTS idx_rag_content_stemmed_trgm;

-- The column itself is dead too. The live tsvector trigger (migration 008) reads only
-- NEW.content, so dropping content_stemmed cannot affect indexing or search.
ALTER TABLE rag_documents DROP COLUMN IF EXISTS content_stemmed;
