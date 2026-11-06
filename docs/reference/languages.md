# Languages

This page lists, for each language-dependent part of the library, which language codes it recognizes and what it does with them: stemming, BM25 index routing, normalization, chunk sizing, the CJK keyword path, and language detection. It ends with what to change to support another language.

## Language codes

A language code is any string up to 10 characters (`rag_documents.language` is `VARCHAR(10)`). Codes are stored exactly as given. Each row's code comes from `chunk.metadata.language`, or else the `language` argument of `RagIndexer.index` (default `"en"`). The query language comes from `RagSearchOptions.language`, or a single-entry `languages` filter.

Components differ in how they match a code:

| Component | Matching |
|-----------|----------|
| `rag_fts_config` (stemming), BM25 index routing, pg_bigm routing, `languages` filter, `recommendForLanguage` `stemming` and `isCjk` | Exact, case-sensitive string match. `pt-BR` does not match `pt`. |
| `normalizeForLanguage`, `Chunker`, `recommendForLanguage` `needsNormalization`, `IntlSegmenterAdapter` | Base code: the part before the first `-`, lowercased. `pt-BR` is treated as `pt`. |

Values in the `languages` filter must not contain a comma.

## Stemming (full-text leg)

`rag_fts_config(lang)` (migration 014) selects the Postgres text search configuration. The tsvector trigger stems each row with its own `language`; `TsvectorFts` stems the query with the query language.

| Codes | Configuration |
|-------|---------------|
| `en`, `en-US`, `en-IN` | `english` |
| `es`, `es-ES`, `es-MX` | `spanish` |
| `fr`, `fr-FR` | `french` |
| `de`, `de-DE` | `german` |
| `it`, `it-IT` | `italian` |
| `pt`, `pt-PT` | `portuguese` |
| `ro`, `ro-RO` | `romanian` |
| `ar`, `ar-SA`, `ar-EG` | `arabic` |
| Any other code | `simple` (lowercasing and tokenizing, no stemming) |

## BM25 indexes

Used only with `Bm25Fts` and `ragMigrate({ bm25: true })`. The BM25 leg searches the partial index for the query language's group. Arabic has no dedicated BM25 index and uses `idx_rag_bm25_simple`.

| Codes | Index | `text_config` |
|-------|-------|---------------|
| `en`, `en-US`, `en-IN` | `idx_rag_bm25_en` | `english` |
| `es`, `es-ES`, `es-MX` | `idx_rag_bm25_es` | `spanish` |
| `fr`, `fr-FR` | `idx_rag_bm25_fr` | `french` |
| `de`, `de-DE` | `idx_rag_bm25_de` | `german` |
| `it`, `it-IT` | `idx_rag_bm25_it` | `italian` |
| `pt`, `pt-PT` | `idx_rag_bm25_pt` | `portuguese` |
| `ro`, `ro-RO` | `idx_rag_bm25_ro` | `romanian` |
| Any other code (including `ar`) | `idx_rag_bm25_simple` | `simple` |

Because the leg is restricted to one group's partial index, a BM25 search only returns rows whose `language` is in the query language's group.

## Normalization

`normalizeForLanguage` and `LanguageNormalizer`. Applied only when a `Normalizer` is configured on `RagIndexer` and `RagPipeline`; it changes `content_normalized` and the lexical query, never the stored `content` or the embedding.

| Base code | Normalization |
|-----------|---------------|
| `ar` | NFC; remove tashkeel, superscript alef, tatweel, ZWNJ and ZWJ; fold alef variants to bare alef; fold `ى` to `ي` and `ة` to `ه` (each can be disabled with `ArabicNormalizeOptions`); convert Arabic-Indic and extended Arabic-Indic digits to ASCII. |
| `th` | NFC; convert Thai digits to ASCII; drop mai yamok `ๆ` and any whitespace before it. |
| Any other | NFC only. |

Full character ranges are in [Utilities: normalizeForLanguage](/reference/utilities#normalizeforlanguage).

## Chunk sizing

In token mode (`new Chunker({ tokenLimit })`), the character limit per chunk is `floor(tokenLimit * ratio)`, with the ratio looked up by the base code of `metadata.language`. In character mode (`new Chunker(chunkSize, overlap)`), language has no effect.

| Base codes | Characters per token | Script |
|------------|----------------------|--------|
| `en`, `es`, `fr`, `de`, `it`, `pt`, `ro`, `ms` | 3.2 | Latin |
| `hi` | 2.4 | Devanagari |
| `ar` | 2.4 | Arabic |
| `si` | 2.4 | Sinhala |
| `th` | 1.5 | Thai |
| `zh`, `ja`, `ko` | 1.2 | CJK |
| Any other, or no `language` in metadata | 1.0 | |

The ratios include a 0.8 safety margin over typical tokenizer averages. They are heuristics; check chunk sizes against your embedder's tokenizer. See [Chunker](/reference/chunker).

## Keyword leg routing

| Condition | Keyword leg | Matches against |
|-----------|-------------|-----------------|
| `PostgresRagDatabase` has `cjk: true`, the query language is exactly `zh`, `zh-CN`, `ja`, `ja-JP`, `ko` or `ko-KR`, and the configured `Segmenter` (if any) does not segment that language | pg_bigm query-bigram coverage, index `idx_rag_content_bigm` (requires `ragMigrate({ cjk: true })`) | `content` (raw) |
| Any other case | pg_trgm `word_similarity`, index `idx_rag_content_normalized_trgm` | `content_normalized` |

Other Chinese, Japanese or Korean codes (for example `zh-TW`) use pg_trgm. See [CJK and segmentation](/how-to/cjk-and-segmentation).

## Language detection

`detectLanguage(text)` returns one of these codes, based on Unicode script counts:

| Result | Returned when |
|--------|---------------|
| `ja` | Any Hiragana or Katakana. |
| `ko` | Any Hangul. |
| `zh` | Han ideographs are at least half of the counted characters (and there is no kana or Hangul). |
| `th` | Thai is more than half. |
| `ar` | Arabic script is more than half. |
| `hi` | Devanagari is more than half. |
| `hinglish` | Devanagari and ASCII Latin letters are both present, neither case above applies. |
| `en` | Anything else, including all Latin-script text and text with no counted characters. |

`detectLanguage` cannot tell Latin-script languages apart, so do not use it to choose between, for example, `en` and `es`. Of its outputs, `en` and `ar` get a stemming configuration; `zh`, `ja` and `ko` can use the pg_bigm path; `hinglish`, `hi`, `th` and the CJK codes use `simple` for full-text search. See [Utilities: detectLanguage](/reference/utilities#detectlanguage).

## Other language-dependent behavior

| Feature | Behavior |
|---------|----------|
| Stop words | Stored per language in `rag_stop_words`, but `RagPipeline` merges all languages into one set and removes any query word found in it. |
| Synonyms | Stored per language in `rag_synonyms`, but query expansion merges all languages into one lookup. |
| Trailing punctuation | `TRAILING_PUNCTUATION` covers Latin, Devanagari, Arabic, CJK full-width and Thai marks. See [Utilities](/reference/utilities#trailing-punctuation). |
| `recommendForLanguage` | Reports `stemming` and `isCjk` by exact code, matching the database and adapter routing above (`pt-BR` reports `stemming: "none"`; `zh-TW` reports `isCjk: false`). Reports `needsNormalization` by base code. |

## Adding a language

Each concern is extended separately. Only stemming can be added without changes to the library.

| Concern | How to extend |
|---------|---------------|
| Stemming | Replace `rag_fts_config` with a version that adds your codes, then rebuild `content_tsvector` for existing rows of those languages (the trigger only runs on insert and update). List the configurations your server has with `SELECT cfgname FROM pg_ts_config`. |
| BM25 | Not configurable. The BM25 language groups are internal to the library; other languages use `idx_rag_bm25_simple` with no stemming. |
| Normalization | Implement [`Normalizer`](/reference/interfaces#normalizer) (it can delegate to `normalizeForLanguage` for other languages) and use it on both the indexer and the pipeline. Re-index existing content. |
| Chunk sizing | The ratio table is internal. Unlisted languages use 1 character per token; use a smaller `tokenLimit`, or character mode with an explicit `chunkSize`. |
| Word segmentation | Implement [`Segmenter`](/reference/interfaces#segmenter), or use `IntlSegmenterAdapter` with the language's base code. |
| Stop words and synonyms | Insert rows with the language code into `rag_stop_words` and `rag_synonyms`. |

Example: add Dutch stemming for the codes `nl` and `nl-NL`.

```sql
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
    WHEN lang IN ('nl', 'nl-NL')          THEN 'dutch'
    ELSE 'simple'
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE rag_documents
SET content_tsvector = to_tsvector(rag_fts_config(language), COALESCE(content_normalized, content))
WHERE language IN ('nl', 'nl-NL');
```

Keep every existing branch when you replace the function. If a later library migration redefines `rag_fts_config` (as migration 014 did), re-apply your additions after upgrading. For the full procedure, see [Multilingual search](/how-to/multilingual-search).

## Related

- [Multilingual search](/how-to/multilingual-search)
- [Language processing](/explanation/language-processing)
- [Schema](/reference/schema)
