# Search across languages

This guide shows how to search a corpus that holds more than one language: setting the query language, scoping or widening the search across document languages, normalizing text, detecting a query's language, and adding a Postgres stemmer for a language the library does not map yet.

For why full-text search works per language while the vector leg can cross languages, see [Language processing](/explanation/language-processing).

## Before you begin

- Index every chunk with its language. `RagIndexer.index()` stamps each row with `chunk.metadata.language`, falling back to the `language` argument. See [Index documents](/how-to/index-documents).
- For cross-language retrieval, use a multilingual embedding model. See [Configure embeddings](/how-to/configure-embeddings).

## Set the query language

Every search needs a query language. Set `language`, or pass a `languages` filter with exactly one entry. `search()` throws before any embedding or database work if neither is set.

```ts
import { RagPipeline } from "pg-hybrid-rag";

declare const pipeline: RagPipeline;

// Query language set explicitly
await pipeline.search("comment changer mon mot de passe", { language: "fr" });

// A single-entry languages filter also sets the query language
await pipeline.search("comment changer mon mot de passe", { languages: ["fr"] });
```

The two options do different jobs:

| Option | What it controls |
| --- | --- |
| `language` | How the query is processed. It selects the Postgres text search config for the full-text leg (`rag_fts_config(language)`), the BM25 partial index when you use `Bm25Fts`, and the pg_bigm keyword path for CJK codes when `cjk: true`. It is also passed to your `Normalizer`, `Segmenter` and filter model. It does not filter documents on its own. |
| `languages` | Which documents are searched. All three legs add `WHERE language = ANY(...)`. A single entry also becomes the query language when `language` is unset. |

## Search one language

Pass the language as a one-entry filter. Only documents indexed with that exact code are searched.

```ts
await pipeline.search("cómo cambiar la contraseña", { languages: ["es"] });
```

Codes are matched exactly. A document indexed as `es-MX` is not returned by `languages: ["es"]`; list every code you index, for example `languages: ["es", "es-MX"]`, and then set `language` too (see below).

::: warning Use codes from the mapped list
The full-text config (`rag_fts_config`), `Bm25Fts` index routing and CJK pg_bigm routing also compare the code exactly, against fixed lists (see [Languages](/reference/languages#language-codes)). A code with an unlisted region or a different case, such as `en-GB`, `pt-BR`, `zh-TW` or `EN`, gets the unstemmed `simple` config, the `simple` BM25 index and the pg_trgm keyword path. `recommendForLanguage()`, `LanguageNormalizer`, `IntlSegmenterAdapter` and the chunker's token-limit sizing use the base code instead (`pt-BR` → `pt`), so `recommendForLanguage("pt-BR").stemming` reports `"portuguese"` even though Postgres does not stem `pt-BR` rows. Index and search with mapped codes such as `en` or `pt`.
:::

## Search several languages

A multi-entry `languages` filter does not infer a query language, so set `language` as well:

```ts
await pipeline.search("cómo cambiar la contraseña", {
  language: "es",
  languages: ["es", "es-MX", "en"],
});
```

## Search across all languages

Omit `languages` and set `language` to the language of the query:

```ts
await pipeline.search("how do I reset my password", { language: "en" });
```

What each leg contributes across languages:

| Leg | Cross-language behavior |
| --- | --- |
| Vector | Matches documents in other languages when the embedding model is multilingual. |
| Keyword (pg_trgm) | Matches shared character sequences, such as product names, codes and loanwords, in any language. |
| Full-text (`TsvectorFts`) | Parses the query with the query language's config. Matches mainly documents in the same language. |
| Full-text (`Bm25Fts`) | Searches only documents in the query language's BM25 group. See [Use BM25 ranking](/how-to/bm25). |

## Detect the query language

When you do not know the user's language, `detectLanguage(text)` guesses it from the Unicode script:

```ts
import { detectLanguage } from "pg-hybrid-rag";

declare const userLocale: string | undefined;

const language = userLocale ?? detectLanguage(query);
await pipeline.search(query, { language });
```

Know its limits before you rely on it:

- It returns one of `en`, `hi`, `hinglish`, `ar`, `th`, `zh`, `ja`, `ko`.
- It cannot tell apart languages that share a script. Any Latin-script text, and empty text, returns `en`.
- Text that is at least half Han characters, with no kana or Hangul, returns `zh`. Kana means `ja` and Hangul means `ko`, even mixed with Latin text.
- Mixed Devanagari and Latin text returns `hinglish`. No stemmer is mapped to that code, and no document is indexed with it unless you do so. Map it to a code you index (for example `hi`) before you use it as a filter.

Prefer a language you already know, such as the user's locale or the language of the page they are on, and use detection as a fallback.

## Normalize text for lexical matching

`LanguageNormalizer` folds spelling variants so the keyword and full-text legs match them. It applies Arabic folds (diacritics, tatweel, alef variants, alef maqsura to yeh, taa marbuta to heh, Arabic-Indic digits to ASCII), folds Thai digits, and applies Unicode NFC to every other language.

Pass the same normalizer to the indexer and the pipeline. The indexer applies it to `content_normalized`; the pipeline applies it to the lexical query. Neither the stored `content`, the embedding, nor the reranker input is changed.

```ts
import { LanguageNormalizer, RagIndexer, RagPipeline } from "pg-hybrid-rag";

const normalizer = new LanguageNormalizer();
// Arabic folds can be switched off individually (both default to true):
// new LanguageNormalizer({ foldAlefMaqsura: false, foldTaaMarbuta: false });

const indexer = new RagIndexer({ tenantId, db, embedder, normalizer });
const pipeline = new RagPipeline({ tenantId, db, embedder, normalizer });
```

::: warning Re-index after you add or change a normalizer
Rows indexed earlier keep their old `content_normalized`. Re-index those sources so stored text and queries are folded the same way.
:::

To plug in your own rules, implement the `Normalizer` interface: `normalize(text, language)` returns a string or a promise of one. Return the input unchanged for languages you do not handle, and keep the output deterministic so indexing and querying agree.

### Rewrite the query per search

`RagSearchOptions.normalizer` is a different hook. It runs on every search before stop-word removal, receives the lowercased, punctuation-stripped query, and its output also feeds the embedding and the reranker. Use it for query rewriting such as abbreviation expansion. It must be synchronous. If it returns an empty string, the pipeline keeps the text it had before the call.

```ts
const abbreviations: Record<string, string> = { acct: "account", pwd: "password" };

await pipeline.search("reset acct pwd", {
  language: "en",
  normalizer: {
    normalize: (text) =>
      text
        .split(" ")
        .map((word) => abbreviations[word] ?? word)
        .join(" "),
  },
});
```

## Add a stemmer for a new language

The `rag_fts_config(lang)` SQL function maps language codes to Postgres text search configs. Codes it does not list use `simple`, which lowercases and tokenizes without stemming. The current mapping is in [Languages](/reference/languages). To stem another language that Postgres supports:

1. Check that Postgres has a config for the language:

   ```sql
   SELECT cfgname FROM pg_ts_config ORDER BY cfgname;
   ```

2. Replace the function. Keep every existing mapping and add yours. The body below is the library's current mapping (from `sql/014_arabic_fts.sql`) plus Dutch:

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
   ```

3. Rebuild the stored tsvectors for rows in that language. The trigger only runs on insert and update, so existing rows keep their `simple` tsvectors until you do this:

   ```sql
   UPDATE rag_documents
   SET content_tsvector = to_tsvector(rag_fts_config(language), COALESCE(content_normalized, content))
   WHERE language IN ('nl', 'nl-NL');
   ```

   With row-level security enabled, run this as a role that can see every tenant's rows.

4. Search with the new code, for example `{ language: "nl" }`.

::: warning Library upgrades can replace your function
A later library migration that redefines `rag_fts_config` overwrites your version. After each upgrade, check whether a migration touched the function and re-apply your mapping if so.
:::

This changes only the tsvector full-text leg. The `Bm25Fts` partial indexes have fixed language groups, so a new language stays on the unstemmed `simple` BM25 index. `recommendForLanguage(code).stemming` also keeps reporting `"none"` for it.

## Related

- [Search Chinese, Japanese, Korean, and Thai text](/how-to/cjk-and-segmentation)
- [Manage stop words and synonyms](/how-to/stop-words-and-synonyms)
- [Languages reference](/reference/languages)
- [Language processing](/explanation/language-processing)
