-- Add tsvector column for full-text search
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS content_tsvector tsvector;

-- Trigger to auto-populate tsvector on INSERT/UPDATE
-- Uses 'simple' config (tokenize + lowercase only) since app-level stemming is in content_stemmed
CREATE OR REPLACE FUNCTION rag_documents_tsvector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.content_tsvector := to_tsvector('simple', COALESCE(NEW.content_stemmed, NEW.content));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rag_documents_tsvector ON rag_documents;
CREATE TRIGGER trg_rag_documents_tsvector
  BEFORE INSERT OR UPDATE ON rag_documents
  FOR EACH ROW EXECUTE FUNCTION rag_documents_tsvector_trigger();

-- GIN index for fast FTS queries
CREATE INDEX IF NOT EXISTS idx_rag_content_fts ON rag_documents USING GIN (content_tsvector);

-- Backfill existing rows
UPDATE rag_documents
SET content_tsvector = to_tsvector('simple', COALESCE(content_stemmed, content))
WHERE content_tsvector IS NULL;
