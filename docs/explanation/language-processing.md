# Language processing

This page explains how pg-hybrid-rag prepares text for each search leg: which steps apply to the embedding and which only to the lexical legs, why stemming happens per row in Postgres, why the full-text leg works in one language per query, and how stop words, synonyms, punctuation, language detection and word segmentation fit in.

## Two audiences for the same text

The search legs need different forms of the text.

- **The embedding model and the cross-encoder reranker** were trained on natural sentences. Stop words, word order and punctuation carry meaning for them. Removing words or inserting artificial spaces moves the text away from what the model saw in training.
- **The lexical legs** (trigram and full-text) compare surface forms. They match better when spelling variants are folded together, when filler words are removed, and when words are clearly separated.

pg-hybrid-rag therefore keeps two versions of every query and every chunk:

| Step | Natural text (embedding, reranker) | Lexical text (trigram, FTS) |
|---|---|---|
| Lowercase, strip trailing punctuation (query only) | Yes | Yes |
| Per-search `normalizer` option (query only, for example abbreviation expansion) | Yes | Yes |
| `Normalizer` (orthographic folding) | No | Yes, on both query and content |
| `Segmenter` (word boundaries) | No | Yes, on both query and content |
| Stop-word removal (query only) | No | Yes |
| Synonym expansion (query only) | No | FTS leg only |
| Stemming | No | FTS leg only, inside Postgres |

On the document side, raw `content` is embedded and stored for display, and `content_normalized` holds the normalized and segmented form for the lexical legs.

There are two separate normalizer hooks, and they do different jobs. The `normalizer` in `RagPipelineConfig` and `RagIndexerConfig` (a `Normalizer`) is lexical only and is applied symmetrically to content and queries. The `normalizer` in `RagSearchOptions` is a per-query rewrite, such as expanding abbreviations, and its output also feeds the embedding.

## Symmetry: the same processing on both sides

Lexical matching only works if the query and the documents went through the same transformations. If documents were folded but queries were not, a folded document would never match an unfolded query.

That is why `Normalizer` and `Segmenter` are injected into both `RagIndexer` (applied to `content_normalized`) and `RagPipeline` (applied to the lexical query). Use the same instance, or at least the same configuration, on both. If you change a normalizer's behavior, re-index, because existing rows still hold the old form. The library cannot detect a mismatch. The usual symptom is lexical legs that quietly stop matching.

## Orthographic normalization

Some scripts write the same word in several ways. `LanguageNormalizer` (built on `normalizeForLanguage`) applies per-language folding:

- **Arabic:** removes diacritics (tashkeel) and tatweel, folds alef variants to bare alef, and by default folds alef maqsura to yeh and taa marbuta to heh. It also converts Arabic-Indic digits to ASCII digits.
- **Thai:** converts Thai digits to ASCII digits.
- **All languages:** Unicode NFC normalization.

Folding is deliberately lossy. Folding taa marbuta to heh, for example, merges some distinct words. That is acceptable for the lexical legs, where recall on variant spellings matters more, and it never touches the text that the embedding model or your users see.

## Stemming happens per row, in Postgres

Full-text search reduces words to stems so that "subscriptions" matches "subscription". pg-hybrid-rag does not stem in TypeScript. A trigger on `rag_documents` builds `content_tsvector` from `content_normalized` with `rag_fts_config(language)`, a SQL function that maps the row's language code to a Postgres text search configuration (`english`, `spanish`, `french`, `german`, `italian`, `portuguese`, `romanian`, `arabic`). Codes not in that map use the `simple` configuration, which lowercases and tokenizes without stemming.

Why stem in Postgres:

- **No runtime dependencies.** Postgres ships Snowball stemmers for many languages.
- **Per-row correctness.** Each row is stemmed with its own language, taken from `chunk.metadata.language` or, if absent, the `language` argument to `RagIndexer.index`. One table can hold documents in many languages, each stemmed correctly.
- **Query and document use the same stemmer.** The query is stemmed by the same Postgres configuration at search time.

Two consequences to keep in mind:

- The map matches exact codes. `en-US` maps to `english`, but a code that is not listed, such as `en-GB` or `pt-BR`, falls back to `simple`. See [Language support](/reference/languages) for the exact list.
- The library applies the same exact-code rule everywhere it routes by language: the stemming map, the BM25 language groups, and the choice of the pg_bigm keyword path (`zh`, `zh-CN`, `ja`, `ja-JP`, `ko` and `ko-KR` only, so `zh-TW` uses pg_trgm). `recommendForLanguage` reports `stemming` and `isCjk` by the same rule, so its advice matches what the database actually does for that code. Normalization is the one exception: `normalizeForLanguage` folds by the base code, so `ar-MA` is folded as Arabic even though it is stemmed with `simple`.
- Postgres language configurations also drop their own built-in stop words. A query made entirely of those words produces an empty `tsquery`, and the FTS leg returns nothing for it. The other legs still run.

## Why the FTS leg works in one language per query

A stemmer is language-specific: English rules applied to a French word produce a meaningless stem. The query is stemmed with one configuration, chosen by the query's `language`, so it reliably matches only rows that were stemmed the same way.

- With `TsvectorFts`, the query is stemmed with the query language's configuration and compared against every row's `tsvector`. Rows in other languages can still match where stems happen to coincide (names, numbers, shared loanwords), but stemmed matches across languages are unreliable.
- With `Bm25Fts`, the leg is explicitly restricted to rows whose language belongs to the query language's group, because each BM25 index is built for one language group. Rows in other groups never reach the BM25 leg. Every language without its own stemmed group (Arabic, Thai, Chinese and so on) shares one `simple` group, so a query in one of those languages still sees rows in the others.

This is why `search` requires a language. Cross-language retrieval comes from the other two legs. The vector leg matches across languages if your embedding model is multilingual, and the trigram leg has no language at all. To restrict all three legs to certain languages, use the `languages` filter. See [Search multilingual content](/how-to/multilingual-search).

## Stop words

Stop words are frequent words such as "the" or "how" that add little to lexical matching and can drown out the words that matter. The pipeline removes them from the lexical query only. The embedding keeps them, because dense models use them to read the sentence.

Design details:

- **Per tenant, merged across languages.** `CachingStopWordsLoader` loads the tenant's rows from `rag_stop_words` and the pipeline removes words from all languages at once. A word listed for one language is removed from queries in every language, so avoid listing words that are meaningful in another language your tenant uses.
- **Applied after normalization and segmentation.** Stop words are compared against the folded, segmented query, so they must be stored in that form. The loader's `normalizeWord` option (for example, `normalizeForLanguage`) folds them on load.
- **Never empties the query.** If every word is a stop word, the pipeline searches with the form before stop-word removal.
- **One row per word.** A unique index on `(tenant_id, language, word)` (migration 020) prevents duplicate rows, so seeding scripts can insert with `ON CONFLICT DO NOTHING`. The comparison is exact: `The` and `the` are separate rows, and the loader lowercases both when it loads them.

## Synonyms

Synonyms bridge vocabulary differences that stemming cannot, such as "cell phone" and "mobile". The pipeline loads them per tenant from `rag_synonyms` and uses them only in the FTS leg:

- With `TsvectorFts`, each matched term becomes an OR group in the `tsquery`, for example `best & (phones | smartphones) & market`. Multi-word synonyms become phrase matches with `<->`.
- With `Bm25Fts`, expansions are appended to the flat term list. An expansion that repeats a word already in the query is not added again, so synonyms do not inflate term frequency.

Matching is longest-first, so a two-word key such as "apple watch" wins over the single word "apple". A `two_way` row also maps each synonym back to the term; a `one_way` row expands only from term to synonyms. Each term keeps at most five expansions.

Synonyms are also merged across languages at query time, and keys are compared with the lowercased lexical query. If you use a `Normalizer` or `Segmenter`, store synonym terms in the normalized, segmented form.

The trigram leg does not use synonyms. It matches the lexical query without expansion, which keeps it focused on spelling-level similarity.

## Punctuation

Before anything else, the pipeline splits the query on whitespace and strips trailing punctuation from each token, covering Latin, Devanagari, Arabic, Thai and CJK marks plus closing brackets, quotes and the ellipsis. This removes noise like the question mark in "refund policy?" without breaking tokens whose punctuation is internal, such as "e-mail" or "v2.1". Leading punctuation is not stripped.

## Language detection

`detectLanguage` guesses a language from Unicode script ranges: Devanagari, Thai, Arabic, Latin, Han, kana and Hangul. It is fast and has no dependencies, and it has limits that follow from looking only at the script:

- It cannot tell apart languages that share a script. English, French and German text all come back as `en`.
- Han text without kana or Hangul is reported as `zh`, so Japanese written only in kanji is misdetected.
- Mixed Devanagari and Latin text returns `hinglish` (unless Devanagari is more than half of it, which returns `hi`). `hinglish` has no stemmer and uses `simple`.

The pipeline never calls it. It is a utility for cases where you have no better signal. If you know the language from your content source or the user's settings, pass that instead.

## Word segmentation

Thai, Chinese and Japanese are written without spaces between words. Without word boundaries, stop-word removal, synonym lookup and full-text tokenization have nothing to work with, and trigram similarity compares runs of characters that cross word boundaries.

A `Segmenter` inserts spaces at word boundaries and must not change, reorder or drop any other character. Applied symmetrically to `content_normalized` and the lexical query, it gives the lexical legs real words to match. The embedding and reranker never see segmented text.

The same segmenter instance should be passed to three places:

- `RagIndexer`, to segment `content_normalized`.
- `RagPipeline`, to segment the lexical query.
- `PostgresRagDatabase`, for routing only. For a CJK language the segmenter handles, the keyword leg uses pg_trgm on `content_normalized` instead of pg_bigm on raw `content`.

`Chunker.chunkSegmented` uses the segmenter only to find safe split points, and emits chunks in their natural, unsegmented form.

The bundled `IntlSegmenterAdapter` uses the runtime's `Intl.Segmenter`, so its quality depends on the ICU dictionary in your runtime. It segments common vocabulary but can split words that are not in the dictionary, such as loanwords and product names. For production use in those languages, consider a dictionary-based or model-based segmenter behind the same interface.

### The CJK path without a segmenter

Without a segmenter, CJK keyword search can use pg_bigm (`cjk: true`). It compares two-character sequences, which needs no word boundaries. The library scores by coverage: the share of the query's bigrams that appear in the chunk. Coverage does not depend on chunk length, unlike pg_bigm's symmetric similarity, which penalizes long chunks. The trade-off is that a bigram can match across a word boundary inside a longer word. The other legs and fusion soften this. See [Search Chinese, Japanese, Korean and Thai](/how-to/cjk-and-segmentation).

## Related

- [Search multilingual content](/how-to/multilingual-search)
- [Manage stop words and synonyms](/how-to/stop-words-and-synonyms)
- [Search Chinese, Japanese, Korean and Thai](/how-to/cjk-and-segmentation)
- [Language support](/reference/languages)
