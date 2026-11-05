# PostgresRagDatabase

`PostgresRagDatabase` is the PostgreSQL implementation of [`RagDatabase`](/reference/interfaces). It runs the vector, keyword and full-text legs of a hybrid search in parallel, and inserts, replaces and deletes chunks in `rag_documents`. All SQL is parameterized and every statement is scoped by `tenant_id`. This page covers the constructor, its options, the methods, the SQL each leg runs, and the planner settings it applies.

```ts
import { Bm25Fts, PostgresRagDatabase } from "pg-hybrid-rag";

const db = new PostgresRagDatabase(txProvider, {
  fts: new Bm25Fts(),
  ivfflatProbes: 20,
});
```

Requires the tables and indexes created by [`ragMigrate`](/reference/migrations) (pgvector and pg_trgm, plus pg_bigm for `cjk` and pg_textsearch for `Bm25Fts`).

## Constructor

<!-- no-check -->
```ts
new PostgresRagDatabase(txProvider: TransactionProvider, options?: PostgresRagDatabaseOptions)
```

| Parameter | Type | Description |
|---|---|---|
| `txProvider` | `TransactionProvider` | Supplies connections. `withConnection(fn)` must run every query inside `fn` on one connection, because the planner settings are transaction-local. See [Connect a database driver](/how-to/connect-database-driver). |
| `options` | `PostgresRagDatabaseOptions` | See below. |

### PostgresRagDatabaseOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `cjk` | `boolean` | `false` | Use pg_bigm for the keyword leg when the query language is `zh`, `zh-CN`, `ja`, `ja-JP`, `ko` or `ko-KR` (exact match). Requires the `cjk: true` migration. |
| `fts` | `FtsStrategy` | `new TsvectorFts()` | Strategy for the full-text leg. See [FTS strategies](/reference/fts-strategies). |
| `ivfflatProbes` | `number` | `10` | IVFFlat lists probed per vector search (`ivfflat.probes`). Postgres's own default is 1. Higher values trade latency for recall. Ignored by a VectorChord `vchordrq` index. Should be a positive integer; the constructor does not validate it. |
| `ivfflatIterativeScan` | `"off" \| "relaxed_order"` | `"off"` | pgvector iterative index scan (`ivfflat.iterative_scan`). With `"relaxed_order"`, a filtered vector search keeps probing lists until it has enough rows. Ignored by `vchordrq`. |
| `ivfflatMaxProbes` | `number` | `4 * ivfflatProbes` | Upper bound on lists probed during an iterative scan (`ivfflat.max_probes`). Only sent when `ivfflatIterativeScan` is not `"off"`. |
| `manageTransaction` | `boolean` | `true` | When `true`, the vector leg, the keyword leg and `replaceSource()` wrap their statements in `BEGIN`/`COMMIT` and issue `ROLLBACK` on error. Set `false` when `withConnection` already runs the callback inside a transaction (for example one that sets `app.current_tenant_id` for RLS); the statements then run in that transaction and rollback is the caller's job. |
| `segmenter` | `Segmenter` | none | Used for routing only. A CJK language for which `segmenter.segmentsLanguage(language)` is `true` uses the pg_trgm keyword leg instead of pg_bigm. Pass the same instance as on `RagPipeline` and `RagIndexer`. |

### Constructor errors

| Condition | Error |
|---|---|
| `ivfflatIterativeScan` is not `"off"` or `"relaxed_order"` (for example `"strict_order"`, which pgvector supports only for HNSW) | `Error`: `ivfflatIterativeScan must be "off" or "relaxed_order" (got <value>)` |
| `ivfflatMaxProbes` is set and is not a positive integer | `Error`: `ivfflatMaxProbes must be a positive integer (got <value>)` |

`ivfflatMaxProbes` is validated even when the iterative scan is off.

## Properties

### supportsAttributeFilters

<!-- no-check -->
```ts
readonly supportsAttributeFilters: boolean
```

`true` when the configured FTS strategy has `supportsAttributeFilters === true`. The vector and keyword legs always apply attribute filters. Both built-in strategies support them, so this is `true` unless you pass a custom strategy without the flag. `RagPipeline` refuses filtered searches when it is not `true`.

## Methods

### hybridSearch()

<!-- no-check -->
```ts
hybridSearch(params: HybridSearchParams): Promise<{
  vectorRows: RankedCandidate[];
  keywordRows: RankedCandidate[];
  ftsRows: RankedCandidate[];
}>
```

Runs the three legs concurrently, each in its own `withConnection` call. `RagPipeline` builds `params`; see [Types](/reference/types) for `HybridSearchParams` and `RankedCandidate`. Each leg returns at most `candidateLimit` rows, best first.

Every leg applies the same optional filters after `tenant_id = $1`:

| Filter | SQL |
|---|---|
| `sourceTypes` | `source_type = ANY(string_to_array($n::text, ','))` |
| `sourceIds` | `source_id::text = ANY(string_to_array($n::text, ','))` |
| `languages` | `language = ANY(string_to_array($n::text, ','))` |
| `attributeFilter` | Compiled attribute clause (see [Filter grammar](/reference/filter-grammar)) |

The list filters are bound as one comma-joined parameter, so a value containing a comma throws `Error` (`<field> filter values must not contain a comma ...`). The shared builder is exported as `buildFilters`.

#### Vector leg

Cosine similarity with pgvector, served by the IVFFlat index or, after the `vectorchord` migration, the `vchordrq` index (same SQL).

- Score: `1 - (embedding <=> $embedding::vector)`.
- Keeps rows with score `>= vectorMinScore`, ordered by `embedding <=> $embedding`, `LIMIT candidateLimit`.
- With `ivfflatIterativeScan: "relaxed_order"` the nearest `candidateLimit` rows are first selected in a `MATERIALIZED` CTE, then the similarity floor is applied and the rows are re-sorted outside it.
- No tie-break columns, so the index can return rows in order.

#### Keyword leg

pg_trgm path (default, and for segmented CJK languages):

- Matches `query <% content_normalized`, which the `gin_trgm_ops` index can serve.
- Score: `word_similarity(query, content_normalized)`.
- The `keywordMinScore` threshold is applied through `pg_trgm.word_similarity_threshold`.
- Ordered by score, then `source_type, source_id, chunk_index, id`.

pg_bigm path (`cjk: true`, CJK query language, not handled by `segmenter`):

- Matches `content =% query` against raw `content`, which the `gin_bigm_ops` index can serve. This is a candidate probe gated by `pg_bigm.similarity_limit = 0.0001`.
- Score: query-bigram coverage, the share of the query's bigrams (from `show_bigm`, excluding every bigram that contains a space, such as the padded start and end bigrams) that also occur in `show_bigm(content)`.
- Keeps rows with coverage `>= keywordMinScore`, ordered by score, then `source_type, source_id, chunk_index, id`.

The keyword leg does not expand synonyms.

#### FTS leg

Delegated to the `fts` strategy with an `FtsContext` built from `params` (`tenantId`, `query`, `synonyms`, `language`, `candidateLimit`, `sourceTypes`, `sourceIds`, `languages`, `attributeFilter`). `PostgresRagDatabase` applies no planner settings and no transaction around this leg. See [FTS strategies](/reference/fts-strategies).

#### Errors

| Condition | Error |
|---|---|
| `params.attributeFilter` is set and `supportsAttributeFilters` is `false` | `AttributeFiltersUnsupportedError`, before any query |
| Any leg rejects | `AggregateError` after all three legs settle. Message: `hybridSearch: <n> of 3 search legs failed (<leg>: <message>; ...)`, with leg names `vector`, `keyword`, `fts`. The original errors are in `.errors`. No partial results are returned. |

### insertChunks()

<!-- no-check -->
```ts
insertChunks(tenantId: string, chunks: ChunkRow[]): Promise<void>
```

`ChunkRow` stands for the inline row type on [`RagDatabase`](/reference/interfaces): `sourceType` (at most 50 characters), `sourceId` (a UUID string), `chunkIndex` (string), `content`, `contentNormalized`, `language`, `embedding` (`number[]`), `metadata` (JSON string) and optional `attributes` (JSON string, default `"[]"`).

Inserts all rows with a single `INSERT INTO rag_documents (tenant_id, source_type, source_id, chunk_index, content, language, embedding, metadata, content_normalized, attributes) VALUES ...`. The embedding is sent as a `[a,b,...]` literal cast to `::vector`; attributes are cast with `::text::jsonb`. An empty array issues no query. No transaction is opened. Does not delete existing rows; `RagIndexer` uses `replaceSource()` instead.

### replaceSource()

<!-- no-check -->
```ts
replaceSource(
  tenantId: string,
  sourceType: string,
  sourceId: string,
  chunks: ChunkRow[],
): Promise<void>
```

On one connection: `DELETE FROM rag_documents WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`, then the same batch `INSERT` as `insertChunks()` when `chunks` is not empty. With `manageTransaction: true` both run between `BEGIN` and `COMMIT`; on error it issues `ROLLBACK` and rethrows the original error (a failed `ROLLBACK` is ignored). With `manageTransaction: false` both run in the caller's transaction and the error is rethrown without `ROLLBACK`. All `chunks` must belong to `(sourceType, sourceId)`.

### deleteBySource()

<!-- no-check -->
```ts
deleteBySource(tenantId: string, sourceType: string, sourceId: string): Promise<void>
```

Runs `DELETE FROM rag_documents WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`. No transaction is opened. Served by the `(tenant_id, source_type, source_id)` index from migration 016.

## Planner settings

The vector and keyword legs set planner settings with `SELECT set_config(name, $value, true)` in one statement before the search query. The third argument (`is_local`) makes each setting last only until the end of the current transaction. Setting names are constants; values are bound parameters.

| Leg | Setting | Value |
|---|---|---|
| Vector | `ivfflat.probes` | `ivfflatProbes` (default `10`) |
| Vector, iterative scan on | `ivfflat.iterative_scan` | `relaxed_order` |
| Vector, iterative scan on | `ivfflat.max_probes` | `ivfflatMaxProbes`, else `4 * ivfflatProbes` |
| Keyword, pg_trgm | `pg_trgm.word_similarity_threshold` | `keywordMinScore` |
| Keyword, pg_bigm | `pg_bigm.similarity_limit` | `0.0001` (fixed candidate floor) |

With `manageTransaction: true` each of these legs sends `BEGIN`, the `set_config` statement, the search query and `COMMIT` on its connection. With `manageTransaction: false` it sends only the `set_config` statement and the search query, and the settings stay local to the caller's transaction.

## Related

- [FTS strategies](/reference/fts-strategies)
- [Schema](/reference/schema)
- [Connect a database driver](/how-to/connect-database-driver)
- [Tune the vector index](/how-to/tune-vector-index)
- [Indexes and performance](/explanation/indexes-and-performance)
