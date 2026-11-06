# Interfaces

This page lists every provider interface exported from `pg-hybrid-rag` (defined in `src/interfaces.ts`), with its members and the contract the library relies on. The library performs no I/O of its own; you supply implementations of these interfaces, or use the shipped adapters.

```ts
import type {
  EmbeddingProvider,
  Normalizer,
  RagLogger,
  SqlClient,
  TransactionProvider,
} from "pg-hybrid-rag";
```

| Interface | Required by | Shipped implementation |
|-----------|-------------|------------------------|
| [`SqlClient`](#sqlclient) | Every database call | None (wrap your driver) |
| [`TransactionProvider`](#transactionprovider) | `PostgresRagDatabase`, loaders, catalog, `ragMigrate` (optional) | None (wrap your driver) |
| [`EmbeddingProvider`](#embeddingprovider) | `RagPipeline`, `RagIndexer` | `OpenAiCompatibleEmbedder` |
| [`RagDatabase`](#ragdatabase) | `RagPipeline`, `RagIndexer` | `PostgresRagDatabase` |
| [`FtsStrategy`](#ftsstrategy) | `PostgresRagDatabase` (`fts` option) | `TsvectorFts`, `Bm25Fts` |
| [`ChunkingProvider`](#chunkingprovider) | Your indexing code | `Chunker` |
| [`StopWordsProvider`](#stopwordsprovider) | `RagPipeline` (optional) | `CachingStopWordsLoader` |
| [`SynonymProvider`](#synonymprovider) | `RagPipeline` (optional) | `CachingSynonymLoader` |
| [`RerankerProvider`](#rerankerprovider) | `RagPipeline` (optional) | None |
| [`Normalizer`](#normalizer) | `RagPipeline`, `RagIndexer` (optional) | `LanguageNormalizer` |
| [`Segmenter`](#segmenter) | `RagPipeline`, `RagIndexer`, `PostgresRagDatabase`, `Chunker` (optional) | `IntlSegmenterAdapter` |
| [`RagLogger`](#raglogger) | Pipeline and indexer (optional) | None (no-op default) |
| [`RagTracer`](#ragtracer), [`RagSpan`](#ragspan) | `RagPipeline` (optional) | None (no-op default) |
| [`MetadataCatalogProvider`](#metadatacatalogprovider) | `RagPipeline` with `autoFilter` | `CachingMetadataCatalog` |
| [`FilterModelProvider`](#filtermodelprovider), [`FilterModelContext`](#filtermodelcontext) | `RagPipeline` with `autoFilter` | `OpenAiCompatibleFilterModel` |

## Database access

### SqlClient

<!-- no-check -->
```ts
interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
}
```

Executes one SQL statement and returns its rows.

Contract:

- Placeholders are Postgres positional parameters (`$1`, `$2`, ...). `params` holds JavaScript strings and numbers. The library never interpolates user input into `sql`.
- Rows are plain objects keyed by column name.
- `query` is also called with no parameters (`params` is `[]`) for migration statements and for the transaction-control statements `BEGIN`, `COMMIT` and `ROLLBACK`.
- Values bound for `jsonb` columns are cast in SQL as `$n::text::jsonb`, and embeddings as `$n::vector` from a `[a,b,c]` text literal, so the driver only needs to send text.

### TransactionProvider

<!-- no-check -->
```ts
interface TransactionProvider {
  withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}
```

Runs `fn` with a `SqlClient` and returns its result.

Contract:

- Every query inside one `withConnection` call must run on the same database connection. The library issues `BEGIN`/`COMMIT` and transaction-local `set_config(..., true)` calls inside one callback, which only work on a pinned connection.
- `PostgresRagDatabase.hybridSearch` calls `withConnection` three times concurrently (one per search leg), so one search can hold up to three pooled connections at once.
- For row-level security, set `app.current_tenant_id` on the connection inside `withConnection`. If your `withConnection` already wraps the callback in a transaction, construct `PostgresRagDatabase` with `manageTransaction: false` (see [PostgresRagDatabase](/reference/postgres-rag-database)).
- `ragMigrate` treats any object with a `withConnection` function as a `TransactionProvider` and then applies each migration file atomically (see [Migrations](/reference/migrations)).

See [Connect your database driver](/how-to/connect-database-driver) for implementations.

### RagDatabase

<!-- no-check -->
```ts
interface RagDatabase {
  readonly supportsAttributeFilters?: boolean;
  hybridSearch(params: HybridSearchParams): Promise<{
    vectorRows: RankedCandidate[];
    keywordRows: RankedCandidate[];
    ftsRows: RankedCandidate[];
  }>;
  insertChunks(tenantId: string, chunks: ChunkRow[]): Promise<void>;
  deleteBySource(tenantId: string, sourceType: string, sourceId: string): Promise<void>;
  replaceSource(
    tenantId: string,
    sourceType: string,
    sourceId: string,
    chunks: ChunkRow[],
  ): Promise<void>;
}

// ChunkRow is written inline in the source; shown here for readability.
type ChunkRow = {
  sourceType: string;
  sourceId: string;
  chunkIndex: string;
  content: string;
  contentNormalized: string;
  language: string;
  embedding: number[];
  metadata: string; // JSON text
  attributes?: string; // serialized attribute JSON; "[]" when omitted
};
```

The storage and search back end used by `RagPipeline` and `RagIndexer`.

| Member | Contract |
|--------|----------|
| `supportsAttributeFilters` | `true` only if `hybridSearch` applies `params.attributeFilter` inside every leg. When absent or `false`, `RagPipeline` throws `AttributeFiltersUnsupportedError` for any filtered search instead of ignoring the filter. |
| `hybridSearch` | Runs the vector, keyword and full-text legs for [`HybridSearchParams`](/reference/types#hybridsearchparams) and returns each leg's candidates ranked best first. The pipeline fuses them by rank (RRF) or by `score` (linear fusion). Should return `[]` without querying for each leg in `params.skipLegs`; the pipeline also discards rows for those legs, so an implementation that ignores `skipLegs` still produces correct results. |
| `insertChunks` | Inserts rows without deleting existing ones. |
| `deleteBySource` | Deletes all rows for `(tenantId, sourceType, sourceId)`. `RagIndexer.deleteSource` uses this method, and so does `RagIndexer.index` when `chunks` is empty. |
| `replaceSource` | Deletes the source's rows and inserts `chunks` in one transaction, rolling back on error, so a failed insert never leaves the source empty. All `chunks` belong to `(sourceType, sourceId)`. `RagIndexer.index` uses this method. |

### FtsStrategy

<!-- no-check -->
```ts
interface FtsStrategy {
  readonly supportsAttributeFilters?: boolean;
  search(client: SqlClient, ctx: FtsContext): Promise<RankedCandidate[]>;
}
```

The full-text leg of `PostgresRagDatabase`. An implementation builds its own query form from `ctx.query` and `ctx.synonyms` and owns the leg's SQL. It runs on the connection it is given and returns candidates best first. Set `supportsAttributeFilters` to `true` only if `search` applies `ctx.attributeFilter`; otherwise `PostgresRagDatabase` reports filters as unsupported. See [FTS strategies](/reference/fts-strategies).

### FtsContext

| Field | Type | Description |
|-------|------|-------------|
| `tenantId` | `string` | Tenant to search. |
| `query` | `string` | Lexical query: lowercased, punctuation-stripped, normalized, segmented and stop-word-filtered. |
| `synonyms` | `SynonymLookup` | Synonym map for query expansion. |
| `language` | `string` | Query language code, used for stemming or index selection. |
| `candidateLimit` | `number` | Maximum rows to return. |
| `sourceTypes` | `string[]` (optional) | Restrict to these source types. |
| `sourceIds` | `string[]` (optional) | Restrict to these source IDs. |
| `languages` | `string[]` (optional) | Restrict to rows in these languages. |
| `attributeFilter` | `ValidatedFilter` (optional) | Already-validated attribute filter that the strategy must apply. |

`buildFilters` and `toRankedCandidate` (see [Utilities](/reference/utilities#sql-helpers)) build the shared filter clauses and map rows the same way the shipped strategies do.

## Embedding and text processing

### EmbeddingProvider

<!-- no-check -->
```ts
interface EmbeddingProvider {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}
```

| Member | Contract |
|--------|----------|
| `embedQuery` | Returns one vector for a search query. `RagPipeline` passes the query lowercased, with trailing punctuation stripped and the per-search `normalizer` applied; stop words are kept. |
| `embedDocuments` | Returns exactly one vector per input text, in input order. `RagIndexer.index` throws if the count differs. |

Every vector must have the dimension of the `rag_documents.embedding` column (`embeddingDimensions` at migration time). Query and document vectors must come from the same model. See [Embedder](/reference/embedder) for `OpenAiCompatibleEmbedder`.

### ChunkingProvider

<!-- no-check -->
```ts
interface ChunkingProvider {
  chunk(text: string, metadata?: Record<string, string>): Chunk[];
  chunkSegmented?(text: string, metadata?: Record<string, string>): Promise<Chunk[]>;
}
```

| Member | Contract |
|--------|----------|
| `chunk` | Splits `text` into [`Chunk`](/reference/types#chunk)s. `Chunker` attaches `metadata` to each chunk and reads `metadata.language` to size chunks in token mode. `RagIndexer` stamps each row with `chunk.metadata.language` when present. |
| `chunkSegmented` | Optional. Uses an injected `Segmenter` to find word boundaries in scripts without spaces, and returns chunks with natural (unsegmented) text. |

See [Chunker](/reference/chunker).

### Normalizer

<!-- no-check -->
```ts
interface Normalizer {
  normalize(text: string, language: string): string | Promise<string>;
}
```

Lexical normalization applied symmetrically: `RagIndexer` applies it to each chunk to produce `content_normalized`, and `RagPipeline` applies it to the lexical query. It feeds the keyword and full-text legs only, never the embedding or the reranker. Use the same configuration on the indexer and the pipeline; changing it requires re-indexing. `LanguageNormalizer` is the shipped implementation (see [Utilities](/reference/utilities#languagenormalizer)).

This interface is distinct from the per-search `normalizer` option of `RagSearchOptions`, which is a synchronous query rewriter whose output also feeds the embedding.

```ts
import type { Normalizer } from "pg-hybrid-rag";

const foldWidth: Normalizer = {
  normalize: (text) => text.normalize("NFKC"),
};
```

### Segmenter

<!-- no-check -->
```ts
interface Segmenter {
  segment(text: string, language: string): string | Promise<string>;
  segmentsLanguage(language: string): boolean;
}
```

Word segmentation for scripts without whitespace word boundaries (for example Thai, Chinese, Japanese).

| Member | Contract |
|--------|----------|
| `segment` | Returns `text` with whitespace inserted at word boundaries, or unchanged for a language it does not handle. It may only insert whitespace: all other characters must be kept in order, and boundaries must fall between grapheme clusters. `Chunker.chunkSegmented` relies on this to rebuild unsegmented chunk text. |
| `segmentsLanguage` | Returns whether `segment` rewrites `language`. Must agree with `segment`. `PostgresRagDatabase` uses it for routing only: a CJK language the segmenter handles uses the pg_trgm keyword leg instead of pg_bigm. |

Like `Normalizer`, it feeds the lexical legs only. `RagIndexer` applies it after the normalizer. Pass the same instance to `RagPipeline`, `RagIndexer`, `PostgresRagDatabase` and `Chunker`. See [CJK and segmentation](/how-to/cjk-and-segmentation).

### StopWordsProvider

<!-- no-check -->
```ts
interface StopWordsProvider {
  load(tenantId: string): Promise<Map<string, Set<string>>>;
  loadMerged?(tenantId: string): Promise<Set<string>>;
  invalidate(tenantId: string): void;
}
```

| Member | Contract |
|--------|----------|
| `load` | Returns stop words per language (`language -> words`). |
| `loadMerged` | Optional. Returns one set across all languages. `RagPipeline` uses it when present; otherwise it merges the result of `load`. |
| `invalidate` | Drops any cached data for the tenant. |

The pipeline removes a query word when its lowercase form is in the merged set, across all languages. Returned maps and sets may be shared cached references; treat them as read-only. See [Loaders](/reference/loaders).

### SynonymProvider

<!-- no-check -->
```ts
interface SynonymProvider {
  load(tenantId: string): Promise<SynonymLookup>;
  invalidate(tenantId: string): void;
}
```

`load` returns a [`SynonymLookup`](/reference/types#synonymlookup) (`language -> term -> expansions`). The returned map may be a shared cached reference; treat it as read-only. See [Loaders](/reference/loaders).

## Ranking

### RerankerProvider

<!-- no-check -->
```ts
interface RerankerProvider {
  rerank(query: string, results: RagResult[], topN: number): Promise<RagResult[]>;
}
```

Called by `RagPipeline` when `rerank: true` and a reranker is configured.

| Argument | Value passed by the pipeline |
|----------|------------------------------|
| `query` | The same natural-language query that was embedded (stop words kept). |
| `results` | Fused candidates: up to `max(topK, rerankCandidates)` when `rerankCandidates` is set, else up to `topK`, after `minRelevance`. |
| `topN` | `topK`. |

Return results with `score` set to the reranker's relevance score. The pipeline drops results below `rerankerMinRelativeScore` or `rerankerMinAbsoluteScore`, sorts the rest by `score` descending and keeps the first `topN`, so a reranker that ignores `topN` or returns results unsorted still yields at most `topK` results, best first. If `rerank` throws, the pipeline logs a warning and returns the first `topK` fused results. See [Rerank results](/how-to/rerank).

## Observability

### RagLogger

<!-- no-check -->
```ts
interface RagLogger {
  debug?(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}
```

Structured logger with an object-first signature. `debug` is optional. When no logger is configured, logging is a no-op.

```ts
import type { RagLogger } from "pg-hybrid-rag";

const consoleLogger: RagLogger = {
  debug: (obj, msg) => console.debug(msg, obj),
  info: (obj, msg) => console.info(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
};
```

### RagTracer

<!-- no-check -->
```ts
interface RagTracer {
  startActiveSpan<T>(name: string, fn: (span: RagSpan) => Promise<T>): Promise<T>;
}
```

Starts a span, calls `fn` with it, and returns `fn`'s result. The library calls `span.end()` on every span it starts, in a `finally` block. When no tracer is configured, tracing is a no-op.

`RagPipeline` starts these spans:

| Span name | Attributes set |
|-----------|----------------|
| `rag-pipeline.search` | `tenantId`, `topK`, `searchMode`, `language`, `normalizerApplied`, `orthographicNormalizerApplied`, `segmenterApplied`, `stopWordsApplied`, `synonymsApplied`, `generatedFilterStatus`, `retriedWithoutGeneratedFilter`, `fusion`, `rerankerApplied`, `vectorCandidates`, `keywordCandidates`, `ftsCandidates`, `resultCount` (some only when the step runs) |
| `rag.embedQuery` | none |
| `rag.dbSearch` | none (started once per database search, twice after an auto-filter retry) |
| `rag.rerank` | `inputCount`, `outputCount`, `error` (on reranker failure) |

### RagSpan

<!-- no-check -->
```ts
interface RagSpan {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}
```

The span handle passed to `RagTracer` callbacks. See [Observability](/how-to/observability).

## Metadata filters

### MetadataCatalogProvider

<!-- no-check -->
```ts
interface MetadataCatalogProvider {
  describe(tenantId: string): Promise<MetadataCatalog>;
  invalidate(tenantId: string): void;
}
```

`describe` returns the tenant's [`MetadataCatalog`](/reference/types#metadatacatalog): keys observed in indexed attributes merged with registered keys. `RagPipeline` calls it for `autoFilter`, passes the catalog to the filter model, and validates the generated filter against it. `invalidate` drops cached data. See [CachingMetadataCatalog](/reference/metadata-catalog).

### FilterModelContext

| Field | Type | Description |
|-------|------|-------------|
| `tenantId` | `string` | Tenant being searched. |
| `language` | `string` | Resolved query language. |
| `signal` | `AbortSignal` (optional) | Aborted when the pipeline's `filterTimeoutMs` deadline expires. Cancel in-flight work when it fires. |

### FilterModelProvider

<!-- no-check -->
```ts
interface FilterModelProvider {
  generateFilter(query: string, catalog: MetadataCatalog, ctx: FilterModelContext): Promise<unknown>;
}
```

Turns a query into a filter expression. `RagPipeline` passes the raw query string as given to `search`. The return type is `unknown` on purpose: the pipeline validates the result with `validateFilter` using the catalog, `rejectUnknownKeys: true` and `enforceAllowedValues: true` (see [Filter grammar](/reference/filter-grammar#validation)).

| Return or outcome | `SearchDiagnostics.generatedFilterStatus` | Effect |
|-------------------|-------------------------------------------|--------|
| `null` or `undefined` | `"none"` | Search runs with the explicit filter only. |
| A valid expression | `"applied"` | ANDed with the explicit filter. |
| An invalid expression | `"invalid"` | Dropped with a warning. |
| Throws, or misses the `filterTimeoutMs` deadline | `"error"` | Dropped with a warning; the search continues. |

## Related

- [Types](/reference/types)
- [Utilities](/reference/utilities)
- [Design principles](/explanation/design-principles)
