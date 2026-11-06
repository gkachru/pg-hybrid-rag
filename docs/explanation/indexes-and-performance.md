# Indexes and performance

This page explains which index serves each search leg, why the SQL is written the way it is so that Postgres can use those indexes, how per-query planner settings work, why the planner sometimes skips an index on purpose, and the trade-offs between the vector index options.

## Which index serves each leg

| Leg or operation | Index | Created by | Index type |
|---|---|---|---|
| Vector | `idx_rag_embedding_ivfflat` | Migration 003 | pgvector IVFFlat, `vector_cosine_ops`, 100 lists |
| Vector (VectorChord option) | `idx_rag_embedding_vchordrq` | Migration 010, replaces IVFFlat | VectorChord `vchordrq` |
| Keyword (pg_trgm) | `idx_rag_content_normalized_trgm` | Migration 013 | GIN, `gin_trgm_ops` on `content_normalized` |
| Keyword (pg_bigm, CJK) | `idx_rag_content_bigm` | Migration 009 | GIN, `gin_bigm_ops` on `content` |
| FTS (tsvector) | `idx_rag_content_fts` | Migration 004 | GIN on `content_tsvector` |
| FTS (BM25) | `idx_rag_bm25_en`, `_es`, `_fr`, `_de`, `_it`, `_pt`, `_ro`, `_simple` | Migrations 011 and 015 | `pg_textsearch` BM25, one partial index per language group, on `content_normalized` |
| Attribute filters | `idx_rag_attributes` | Migration 017 | GIN, `jsonb_path_ops` |
| Tenant filter | `idx_rag_tenant` | Migration 002 | B-tree on `tenant_id` |
| Re-index and delete | `idx_rag_source` | Migration 016 | B-tree on `(tenant_id, source_type, source_id)` |
| Stop-word uniqueness | `idx_rag_stop_words_tenant_lang_word` | Migration 020 | Unique B-tree on `rag_stop_words (tenant_id, language, word)` |

All of these indexes are on `rag_documents` except the last, which keeps `rag_stop_words` free of duplicate rows rather than serving a search leg.

Two kinds of index serve the search legs, and they behave differently:

- **Ordered indexes** return rows already in score order: the vector indexes (nearest first) and BM25 (best first). The leg can stop after `candidateLimit` rows.
- **Matching indexes** return the set of rows that match, in no particular order: the GIN indexes for trigrams, bigrams and `tsvector`. The leg then scores every matching row and sorts. Its cost grows with the number of matches, so a broad query, or a low `keywordMinScore`, costs more in these legs.

## Writing predicates the index can use

Postgres uses an index only for a predicate of the form `indexed_column OPERATOR value`, where the operator belongs to the index's operator class. A function call compared with a constant is opaque to the planner.

The trigram leg shows the difference. The natural way to write "word similarity of at least 0.35" is:

```sql
WHERE word_similarity($2, content_normalized) >= 0.35   -- cannot use the GIN index
```

`gin_trgm_ops` cannot serve that, so Postgres would compute `word_similarity` for every row of the tenant. The library writes it with pg_trgm's word-similarity operator instead:

```sql
WHERE $2 <% content_normalized                          -- can use the GIN index
```

`<%` is in `gin_trgm_ops`, so the index finds candidate rows. The operator has no threshold argument. It compares against the `pg_trgm.word_similarity_threshold` setting, so the library sets that setting to `keywordMinScore` for the query. The leg still computes `word_similarity` for the rows the index returns, to rank them.

The CJK leg uses the same idea with pg_bigm's `=%` operator and its `pg_bigm.similarity_limit` setting, with a twist. pg_bigm's similarity is symmetric, so long chunks score low even when they contain the whole query. The library sets the limit to a very low floor (0.0001), so the index acts only as a net that finds rows sharing bigrams with the query. It then filters and ranks those rows by coverage, the share of the query's bigrams found in the chunk, against `keywordMinScore`. The floor has to stay above zero: at zero every row passes the operator, and the index stops narrowing anything.

## Per-query planner settings

These settings are applied per query:

| Setting | Leg | Value |
|---|---|---|
| `pg_trgm.word_similarity_threshold` | Keyword (pg_trgm) | `keywordMinScore` |
| `pg_bigm.similarity_limit` | Keyword (pg_bigm) | Fixed internal floor, 0.0001 |
| `ivfflat.probes` | Vector | `ivfflatProbes` (default 10) |
| `ivfflat.iterative_scan`, `ivfflat.max_probes` | Vector | Only when `ivfflatIterativeScan` is not `"off"` |

All of a leg's settings go out in one `SELECT set_config(...)` round trip, with `is_local = true`, so they last only until the end of the leg's transaction. [Tenancy, connections and security](/explanation/tenancy-and-security) explains why this needs a pinned connection and how it interacts with your own transactions.

## Tenant selectivity changes the plan

Every leg filters on `tenant_id`. When the table holds many tenants, the planner has two strategies for a leg:

1. Use the leg's specialized index (IVFFlat, GIN, BM25) across the whole table and discard other tenants' rows.
2. Use the `idx_rag_tenant` B-tree to fetch only this tenant's rows, compute the score for each of them, and sort.

When the tenant is a small share of the table, the second plan touches fewer rows and the planner tends to pick it. The leg then ignores the specialized index on purpose. This is the planner working as intended, and it has two effects:

- **Results are exact.** The vector leg computes the true distance for every row of the tenant instead of an approximate scan, so there is no approximate-index recall loss for that tenant.
- **Cost follows tenant size, not table size.** A small tenant stays fast however large the table grows. A large tenant behaves like a single-tenant deployment.

When one tenant holds most of the table, as in a single-tenant deployment, the tenant B-tree filters almost nothing, and the specialized indexes do the work. Index tuning such as IVFFlat probes or a VectorChord build therefore matters most for large tenants. Check `EXPLAIN` output with realistic data for your largest tenants before tuning.

The repository's integration test suite checks the opposite case. It hides the tenant B-trees and penalizes sequential scans, to prove that each leg can use its own index when the planner has no shortcut.

## The vector index

### IVFFlat probes

IVFFlat divides vectors into lists (clusters) at build time. A query scans only the lists nearest to the query vector. `ivfflat.probes` sets how many. Postgres defaults to 1, which scans one of the 100 lists and misses neighbors that fall in an adjacent list. The library defaults to 10. More probes improve recall and cost more time. The right `lists` value depends on corpus size. The migration uses 100, which suits small and medium corpora, and you can rebuild the index with a different value.

### Filters and iterative scans

An approximate index scan and a `WHERE` filter interact badly. The scan visits the probed lists, and then the filter removes rows. If the filter is selective (a narrow `sourceIds`, `languages` or attribute filter), the probed lists may not contain enough passing rows, and the leg returns fewer than `candidateLimit` results even though more exist.

pgvector 0.8 added iterative scans for this. With `ivfflatIterativeScan: "relaxed_order"`, the scan keeps probing more lists until enough rows pass the filter, up to `ivfflat.max_probes`. The library defaults that cap to four times `ivfflatProbes`, so a filter that matches almost nothing cannot make the scan walk the whole index. The query shape also changes:

- The scan runs inside a materialized CTE, and the `vectorMinScore` floor is applied outside it, so the floor does not interfere with the iterative scan.
- `relaxed_order` can return rows slightly out of order, so the leg sorts again outside the CTE. The outer sort uses `distance + 0`, which stops the planner (on Postgres 17 and later) from pushing the sort back into the index scan.

`"strict_order"` is rejected because pgvector supports it only for HNSW, not IVFFlat.

### VectorChord: flat versus partitioned

Migration 010 (`vectorchord: true`) replaces IVFFlat with a VectorChord `vchordrq` index. The query SQL is identical, because both use the `<=>` operator. The `ivfflat.*` settings do nothing for `vchordrq`, and the library sets no VectorChord settings of its own.

The migration creates the index without build options, which produces a flat index: it has no partitions. A flat index has nothing to prune, so each query still considers every vector in the index, and its cost grows with the corpus like a full scan. A partitioned (IVF) `vchordrq` build, configured with lists at index creation, lets a query skip most partitions, so its cost grows much more slowly with the corpus, at the cost of approximate recall and build-time tuning. The library does not create that build. If you need it, create the index yourself. See [Tune the vector index](/how-to/tune-vector-index).

## BM25 partial indexes per language group

`pg_textsearch` builds a BM25 index with one text configuration, which fixes the stemmer. To stem each language correctly, the migrations create one partial index per language group, each with a `WHERE language IN (...)` predicate and the matching configuration, plus a `simple` catch-all for every other language.

`Bm25Fts` adds the same predicate to the query for the query's language group. Postgres can only use a partial index when the query's predicate implies the index's predicate, and it proves that by comparing literal values, not by calling functions. That is why the language lists are literals in both the SQL migrations and the TypeScript constant `BM25_LANGUAGE_GROUPS`, kept in sync by a test, and why `Bm25Fts` passes the index name to `to_bm25query`, as `pg_textsearch` requires.

Two consequences:

- The BM25 leg only sees rows in the query language's group. See [Language processing](/explanation/language-processing#why-the-fts-leg-works-in-one-language-per-query).
- Languages without a group, including Arabic, use the `simple` index, which does not stem. The tsvector strategy does stem Arabic.

`pg_textsearch` fills its top results up to the `LIMIT` with documents that share no term with the query, scored exactly 0. Fusion uses ranks, so those rows would look like lexical matches. `Bm25Fts` drops them after fetching instead of adding `score > 0` to the SQL. A plain `ORDER BY ... LIMIT` is what lets `pg_textsearch` use its optimized top-k search, and an extra predicate could prevent that.

## Deterministic tie order

When two rows have the same score, Postgres returns them in whatever order the scan or sort produced, which can change after a vacuum, a re-index or a plan change. If the tie sits at the `LIMIT` cut, a row can drop in and out of the results between identical runs.

The sort-based legs (pg_trgm, pg_bigm and tsvector) add a tie-breaker after the score: `source_type, source_id, chunk_index, id`. These keys come from the source rather than from the random row id alone, so the order also survives re-indexing a source. Trigram and coverage scores tie often, because they are ratios of small integers, so this matters in practice.

The vector and BM25 legs do not add a tie-breaker. Their indexes return rows already in score order, and an extra sort key would force a full sort and stop the index from returning the top rows directly. Exact ties in those scores are rare.

Fusion itself is deterministic for a given set of leg results: equal fused scores keep the order in which the chunks were first seen (vector leg first, then keyword, then FTS).

## Other cost controls

- **`candidateMultiplier`** sets each leg's `LIMIT` (`topK * candidateMultiplier`). It bounds the rows each leg ranks and returns, and the size of the union available to the reranker.
- **A weight of 0** (`vectorWeight`, `keywordWeight` or `ftsWeight`) skips that leg's query and connection entirely.
- **Attribute JSON is cast to text above the `LIMIT`** in the sort-based legs, so the cast runs on at most `candidateLimit` rows, not on every matching row.
- **The source index** makes re-indexing and deleting a source an index range scan over that source's chunks, instead of a scan over all of the tenant's rows.
- **Large index builds.** Migrations 013 and 016 build indexes inside the migration transaction. On a large existing table, build them with `CREATE INDEX CONCURRENTLY` before running the migration; the migration's `IF NOT EXISTS` then skips them. See [Run migrations](/how-to/run-migrations).

## Related

- [Tune the vector index](/how-to/tune-vector-index)
- [Use BM25 full-text search](/how-to/bm25)
- [Tune relevance](/how-to/tune-relevance)
- [Schema reference](/reference/schema)
- [ragMigrate and migrations](/reference/migrations)
