# Production checklist

Use this list before you put pg-hybrid-rag in front of users. Each item links to the guide that covers it.

## Database

- **Extensions.** pgvector 0.8.7 or later (0.8.6 and earlier have an IVFFlat build overflow, [pgvector#1036](https://github.com/pgvector/pgvector/issues/1036)) and pg_trgm are installed. Optional extensions you use (VectorChord, pg_textsearch, pg_bigm) are installed, and those that need it are in `shared_preload_libraries`. See [Prepare PostgreSQL](/how-to/prepare-postgres).
- **Migrations.** `ragMigrate` runs at deploy time with a `TransactionProvider`, so each migration file applies atomically. The `rls`, `cjk`, `vectorchord` and `bm25` flags match the features you use. See [Run migrations](/how-to/run-migrations).
- **Embedding dimension.** `embeddingDimensions` on the first migration matches your embedding model. It only applies to a fresh install; changing it later needs a manual `ALTER` and a full re-embed. See [Configure embeddings](/how-to/configure-embeddings).
- **Vector index.** The IVFFlat index was rebuilt after the initial data load, and `ivfflatProbes` was chosen for your `lists`. See [Tune the vector index](/how-to/tune-vector-index).
- **Backups** are out of scope for the library. Cover the RAG tables with your normal Postgres backup and restore process.

## Connections and tenancy

- **Connection pinning.** `withConnection` runs every query in its callback on one connection. If your provider already wraps the callback in a transaction, the adapter uses `manageTransaction: false`. See [Connect your database driver](/how-to/connect-database-driver).
- **Row-level security.** With `rls: true`, each transaction sets `app.current_tenant_id`. The application connects as a role that is not a superuser and lacks `BYPASSRLS`, since those roles bypass the policies; a separate non-owner role is preferred. Migration 021 forces the policies on the table owner too, so any process that connects as the owner (scripts, seeding, backfills) must also set the tenant or it sees no rows. See [Use multi-tenancy and row-level security](/how-to/multi-tenancy-rls).
- **ID formats.** Tenant IDs and source IDs are UUIDs; the columns are typed `uuid`.

## Relevance

- **Query language.** Every search passes `language` (or a single-entry `languages`). See [Search across languages](/how-to/multilingual-search).
- **`vectorMinScore`.** Calibrated for your embedding model. The `0.8` default suits e5-family models and can silently drop the vector leg for others. See [Tune relevance](/how-to/tune-relevance#calibrate-vectorminscore-for-your-embedder).
- **Evaluation set.** A labeled query set exists, and you have a baseline to compare against after changes. See [Tune relevance](/how-to/tune-relevance#measure-recall-k-and-mrr).
- **Reranking.** If you rerank, the provider has a timeout, so a slow service falls back to the fused results instead of holding the search open. See [Rerank results](/how-to/rerank#handle-reranker-failures).

## Metadata

- **Attribute limits.** The defaults (50 attributes, 20 values per attribute, 256 characters per string) fit your documents, or `attributeLimits` is set on the indexer. See [Filter search results by metadata](/how-to/filter-by-metadata).
- **User-supplied filters** are validated with `validateFilter` before the search, and errors go back to the caller.
- **Legacy rows** indexed before attributes existed were re-indexed if they must be filterable.
- **Auto-filter.** `filterTimeoutMs` and the filter model's `timeoutMs` and retries fit together, and you watch `generatedFilterStatus`. See [Generate filters from the query](/how-to/auto-filter#fit-the-timeouts-together).

## Timeouts and failures

- **Embedder.** `OpenAiCompatibleEmbedder` defaults to a 30-second timeout and 2 retries. Lower the timeout for the search path if needed. See [Configure embeddings](/how-to/configure-embeddings).
- **Filter model.** 10-second request timeout and 1 retry by default, bounded by the pipeline's 3-second `filterTimeoutMs`.
- **Reranker and segmenter.** The library sets no timeout on your providers; set one in each.
- **Search legs fail fast.** Any leg's error fails the whole search. Your caller decides whether to retry or show an error.

## Observability

- A `logger` is set on the pipeline and the indexer, a `tracer` on the pipeline, and you alert on reranker and filter-model warnings. See [Monitor searches](/how-to/observability).

## Reindexing

- **Content changes.** `index()` replaces a source's chunks atomically; call it whenever a document changes, and `deleteSource()` when it is removed. See [Index documents](/how-to/index-documents).
- **Changes that need a full re-index:** a different embedding model or dimension, a new or changed `Normalizer` or `Segmenter`, or different chunker settings.
- **New stemmer mappings** need a tsvector rebuild, not a re-embed. See [Search across languages](/how-to/multilingual-search#add-a-stemmer-for-a-new-language).
- **Caches.** Stop words and synonyms are cached for 30 seconds per tenant, and the metadata catalog for 5 minutes. Call `invalidate(tenantId)` after bulk changes if they must show up sooner. See [Manage stop words and synonyms](/how-to/stop-words-and-synonyms).

## Related

- [How-to guides](/how-to/)
- [Tenancy and security](/explanation/tenancy-and-security)
- [Indexes and performance](/explanation/indexes-and-performance)
