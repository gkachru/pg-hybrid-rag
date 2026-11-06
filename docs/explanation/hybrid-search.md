# How hybrid search works

This page explains why pg-hybrid-rag runs three retrieval methods side by side instead of one, what each method is good and bad at, and how a query moves from a string to a ranked list of chunks.

## Why one retrieval method is not enough

Each common retrieval method fails on a different kind of query.

| Query | Dense vectors | Trigram keyword | Full-text search |
|---|---|---|---|
| "how do I get my money back" (paraphrase of "refund policy") | Strong: matches meaning, not words | Weak: few shared character sequences | Weak: no shared stems |
| "error E-4021" (an exact code) | Weak: codes carry little meaning for an embedding model | Strong: exact character overlap | Moderate: depends on how the parser tokenizes the code |
| "recieve invoice" (typo) | Moderate | Strong: most trigrams still match | Weak: the misspelled word stems to a token no document contains |
| "cancelled subscriptions" vs. a document that says "cancel a subscription" | Strong | Moderate | Strong: both stem to "cancel" and "subscript" |
| A product name the embedding model never saw | Weak | Strong | Strong |

Dense retrieval generalizes across wording but blurs exact identifiers and rare terms. Lexical retrieval is precise about the words that appear but cannot connect two different ways of saying the same thing. Running both and combining the results lets each method cover the other's blind spots.

pg-hybrid-rag splits the lexical side into two legs because trigram matching and full-text search fail differently. Trigrams compare character sequences, so they tolerate typos, partial words and codes, but they know nothing about language. Full-text search tokenizes and stems words with a language-specific Postgres configuration, so it matches inflected forms, but it needs correctly spelled words.

## The three legs

Every search runs three queries against the same `rag_documents` table:

| Leg | Matches on | Score | Selection rule |
|---|---|---|---|
| **Vector** | `embedding` (pgvector, cosine distance `<=>`) | Cosine similarity, `1 - distance` | Similarity at or above `vectorMinScore` |
| **Keyword** | `content_normalized` with pg_trgm `word_similarity`, or raw `content` with pg_bigm query-bigram coverage for CJK | Word similarity or coverage, 0 to 1 | Score at or above `keywordMinScore` |
| **FTS** | `content_tsvector` with `tsquery` (default), or `content_normalized` with BM25 when you use `Bm25Fts` | `ts_rank_cd`, or the BM25 score | Any row that matches the query; BM25 drops zero-score rows |

Each leg returns at most `topK * candidateMultiplier` rows (10 with the defaults of 5 and 2). The legs are combined by fusion, which is covered in [Fusion and reranking](/explanation/fusion-and-reranking). Setting a leg's weight (`vectorWeight`, `keywordWeight` or `ftsWeight`) to 0 disables that leg: its query does not run, and the search uses the remaining legs.

The FTS leg is pluggable through the `FtsStrategy` interface. The two bundled strategies behave differently in a way that matters for recall:

- `TsvectorFts` builds a `tsquery` that requires every remaining query term (terms are joined with `&`, with synonym alternatives grouped by `|`). It is precise, and a long query can match nothing.
- `Bm25Fts` sends a flat list of terms that BM25 ranks with OR semantics, so a document that matches some of the terms still scores. It ranks by term frequency and rarity, but needs the `pg_textsearch` extension.

## Four representations of one chunk

Each row in `rag_documents` stores the same chunk text in several forms, because each leg needs something different.

| Column | Contents | Used by |
|---|---|---|
| `content` | The chunk text as you indexed it | Display, the embedding, the pg_bigm CJK keyword path |
| `content_normalized` | `content` after the optional `Normalizer` and `Segmenter` | pg_trgm keyword leg, BM25, and the source of `content_tsvector` |
| `content_tsvector` | Built by a trigger from `content_normalized` with the row's language configuration | Tsvector FTS leg |
| `embedding` | The vector your `EmbeddingProvider` returned for `content` | Vector leg |

Keeping raw `content` separate from `content_normalized` lets the lexical legs match folded or segmented text while the embedding model and your users still see natural text. See [Language processing](/explanation/language-processing) for why that split exists.

## The query flow

`RagPipeline.search` (and `searchWithDiagnostics`, which returns the same results plus filter diagnostics) runs these steps:

```text
 query string + options (language is required)
        |
        v
 +-------------------------------+
 | validate                      |  language present? filter valid?
 | (fails before any I/O)        |  database supports attribute filters?
 +-------------------------------+
        |
        v
 +-------------------------------+
 | lowercase, split on spaces,   |
 | strip trailing punctuation    |
 | optional per-search normalizer|  (abbreviation expansion; feeds everything)
 +-------------------------------+
        |
        +----------------------------+
        |                            |
        v                            v
  natural query                lexical query
  (embedding, reranker)        = natural query
        |                        -> Normalizer (orthographic folding)
        |                        -> Segmenter (word boundaries)
        |                        -> remove stop words
        |                            |
        v                            v
 +-----------------------------------------------------+
 | in parallel: embed natural query | load synonyms |   |
 |              generate filter (only with autoFilter) |
 +-----------------------------------------------------+
        |
        v
 +-----------------------------------------------------+
 | RagDatabase.hybridSearch: three legs in parallel,    |
 | each on its own connection, same filters in each     |
 |                                                      |
 |   vector leg        keyword leg         FTS leg      |
 |   (embedding)       (lexical query)     (lexical     |
 |                                          query +     |
 |                                          synonyms)   |
 +-----------------------------------------------------+
        |   (if a generated filter emptied every enabled leg,
        |    run once more with only the explicit filter)
        v
 +-------------------------------+
 | fuse: RRF (default) or linear |  keep topK, or more when reranking
 +-------------------------------+
        |
        v
 +-------------------------------+
 | optional minRelevance cutoff  |  fraction of the top fused score
 +-------------------------------+
        |
        v
 +-------------------------------+
 | optional rerank + score floors|  cross-encoder sees the natural query;
 +-------------------------------+  output sorted by score, cut to topK
        |
        v
   RagResult[]
```

A few design choices in this flow are worth calling out.

**The language is required.** `search` throws if you pass neither `language` nor a single-entry `languages` filter. An earlier version defaulted to English, which silently stemmed and scoped non-English queries as English. The language selects the FTS stemmer and, with BM25, the per-language index.

**Validation happens first.** An invalid metadata filter, a missing `filterModel`, or a database that cannot apply attribute filters fails before the pipeline pays for an embedding call or a database round trip.

**Two versions of the query.** Stop-word removal, orthographic folding and word segmentation help the lexical legs, which compare surface forms. They hurt the embedding and the cross-encoder, which were trained on natural sentences. The pipeline therefore keeps a natural query for the models and a lexical query for the SQL legs. If a lexical step would leave the query empty (for example, a query made only of stop words), the pipeline falls back to the form before that step.

**Synonyms feed only the FTS leg.** The trigram leg compares the lexical query without expansion. Synonym expansion goes into the `tsquery` (as OR groups) or the BM25 term list.

**The legs run concurrently.** `PostgresRagDatabase` opens one `withConnection` scope per enabled leg at once, so one search uses up to three pooled connections. A leg disabled by a weight of 0 takes no connection. It waits for all three legs to settle, then fails the whole search with an `AggregateError` if any leg failed. It does not return partial results, because a search that silently lost a leg would look healthy while returning worse rankings.

**Filters apply inside every leg.** `sourceTypes`, `sourceIds`, `languages` and attribute filters are added to each leg's `WHERE` clause. Filtering after fusion would under-return: each leg has already cut its list to `candidateLimit` rows, so rows that pass the filter but ranked below the cut would be lost.

## The indexing flow

`RagIndexer.index` mirrors the query side, so that documents and queries are processed the same way.

```text
 chunks (from Chunker or your own ChunkingProvider)
        |
        v
 validate attributes  -------------------- fails before embedding
        |
        v
 embed every chunk's raw content (embedDocuments)
        |
        v
 per chunk: language = chunk.metadata.language ?? index() language
            content_normalized = Segmenter(Normalizer(content))
        |
        v
 replaceSource: DELETE the source's rows + INSERT new rows, one transaction
        |
        v
 trigger builds content_tsvector with rag_fts_config(row language)
```

Re-indexing a source replaces all of its chunks atomically. If the insert fails, the delete rolls back and the source keeps its previous chunks rather than ending up empty. Indexing a source with an empty chunk list is a replacement with nothing: the source's existing rows are deleted, nothing is embedded, and stale content stops matching searches.

## Trade-offs of this design

- **Cost per search.** Three queries (fewer if you disable a leg with a weight of 0) and one embedding call per search, plus a reranker call if enabled. The query is embedded even when the vector leg is disabled. Each leg is bounded by `candidateLimit`, so the extra work is predictable.
- **One database.** All three legs live in Postgres, so filters, tenancy and transactions are consistent across them, and there is no second store to keep in sync. The trade-off is that you are limited to the index types your Postgres extensions provide. See [Indexes and performance](/explanation/indexes-and-performance).
- **Tunable but not self-tuning.** Thresholds such as `vectorMinScore` and `keywordMinScore` depend on your embedding model and corpus. The defaults are starting points. Validate them on your own queries, as described in [Tune relevance](/how-to/tune-relevance).

## Related

- [Fusion and reranking](/explanation/fusion-and-reranking)
- [Language processing](/explanation/language-processing)
- [RagPipeline reference](/reference/rag-pipeline)
- [PostgresRagDatabase reference](/reference/postgres-rag-database)
