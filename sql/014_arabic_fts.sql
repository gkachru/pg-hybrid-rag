-- Add Arabic to the FTS config map (Postgres ships a built-in 'arabic' Snowball config, PG12+).
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
    WHEN lang IN ('ar', 'ar-SA', 'ar-EG') THEN 'arabic'
    ELSE 'simple'
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Build the tsvector from the normalized text (orthographic fold -> Snowball stemming).
-- COALESCE keeps the FTS leg safe if a row is ever written without a normalized form.
CREATE OR REPLACE FUNCTION rag_documents_tsvector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.content_tsvector := to_tsvector(
    rag_fts_config(NEW.language),
    COALESCE(NEW.content_normalized, NEW.content)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Backfill every row's tsvector under the new config + normalized source.
UPDATE rag_documents
SET content_tsvector = to_tsvector(
  rag_fts_config(language),
  COALESCE(content_normalized, content)
);
