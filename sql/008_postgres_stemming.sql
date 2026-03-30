-- Language → Postgres FTS config mapping
-- Supports both short codes (en) and BCP-47 locale codes (en-US)
CREATE OR REPLACE FUNCTION rag_fts_config(lang TEXT) RETURNS regconfig AS $$
BEGIN
  RETURN CASE
    WHEN lang IN ('en', 'en-US', 'en-IN') THEN 'english'
    WHEN lang IN ('es', 'es-ES', 'es-MX') THEN 'spanish'
    WHEN lang IN ('fr', 'fr-FR')          THEN 'french'
    WHEN lang IN ('de', 'de-DE')          THEN 'german'
    WHEN lang IN ('it', 'it-IT')          THEN 'italian'
    WHEN lang IN ('pt', 'pt-PT')          THEN 'portuguese'
    WHEN lang IN ('ro', 'ro-RO')          THEN 'romanian'
    ELSE 'simple'
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Update tsvector trigger to use language-specific config instead of 'simple'
-- Postgres now handles stemming — app-level stemming via content_stemmed is no longer used
CREATE OR REPLACE FUNCTION rag_documents_tsvector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.content_tsvector := to_tsvector(rag_fts_config(NEW.language), NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Backfill existing rows with language-specific tsvector
UPDATE rag_documents
SET content_tsvector = to_tsvector(rag_fts_config(language), content);
