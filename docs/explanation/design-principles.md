# Design principles

This page explains the principles behind pg-hybrid-rag's API: why everything is passed in at construction, why the library has no runtime dependencies or environment variables, how interfaces and plain functions divide the work, and what the library deliberately leaves to you.

## The library is a component, not a service

pg-hybrid-rag runs inside your application. It does not start servers, read configuration files or manage connections. Your application already has opinions about database drivers, connection pools, secrets, logging and deployment, and a library that brought its own versions of those would conflict with them. The library takes the smallest possible set of decisions and lets you make the rest.

The principles below follow from that.

## Dependency injection

Everything with side effects is passed in when you construct an object:

```ts
import { CachingStopWordsLoader, PostgresRagDatabase, RagPipeline } from "pg-hybrid-rag";

const database = new PostgresRagDatabase(txProvider);
const stopWords = new CachingStopWordsLoader({ txProvider });

const search = new RagPipeline({
  tenantId,
  db: database,
  embedder,
  stopWords,
  logger,
});
```

`txProvider`, `embedder` and `logger` here are objects you build around your own driver, embedding service and logger. The pipeline never decides where its data lives or how it reaches a model.

This has practical consequences:

- **Testing without infrastructure.** The library's own test suite replaces the database, embedder and reranker with in-memory fakes. You can do the same in your tests.
- **Swapping implementations.** Moving from one embedding service to another, or from the tsvector FTS leg to BM25, is a change to one constructor argument.
- **Visible configuration.** Everything a pipeline depends on appears in its constructor call. Nothing is picked up from the environment.

## Interfaces for I/O, functions for transforms

The library separates two kinds of extension point.

**Anything that does I/O, or that you may want to replace as a whole component, is an interface** in `interfaces.ts`, injected at construction: `SqlClient`, `TransactionProvider`, `EmbeddingProvider`, `RerankerProvider`, `RagDatabase`, `FtsStrategy`, `StopWordsProvider`, `SynonymProvider`, `Normalizer`, `Segmenter`, `ChunkingProvider`, `FilterModelProvider`, `MetadataCatalogProvider`, `RagLogger` and `RagTracer`. The core classes depend only on these interfaces. The bundled adapters, such as `PostgresRagDatabase` or `OpenAiCompatibleEmbedder`, are ordinary implementations that you can replace.

**Pure transformations are exported functions**: `applyRRF`, `applyLinearFusion`, `removeStopWords`, `stripTrailingPunctuation`, `expandQueryWithSynonyms`, `buildFtsQuery`, `buildBm25Query`, `normalizeForLanguage`, `detectLanguage`, `validateFilter` and others. They take data and return data. You can call them directly, for example to reproduce what the pipeline does to a query while debugging, or to fuse results from your own retrieval.

The choice between them follows from what the code does. Fusion does no I/O and is chosen per query (`fusion: "rrf"` or `"linear"`), so it is a function selected by an option, not an injected strategy object. The FTS leg runs SQL, so it is an `FtsStrategy` injected into the database adapter.

## Capabilities are declared, and missing ones fail closed

When a feature depends on an implementation doing something extra, the implementation has to say it does. A `RagDatabase` or `FtsStrategy` must set `supportsAttributeFilters: true` before the pipeline sends it an attribute filter. An implementation that predates the feature keeps compiling, and the pipeline refuses filtered searches against it instead of trusting it to apply a filter it has never heard of. See [The metadata model](/explanation/metadata-model#fail-closed).

## No runtime dependencies

The published package has an empty `dependencies` list. Everything it needs comes from the JavaScript runtime (`fetch`, `AbortController`, `Intl.Segmenter`, `node:fs` for reading migration files) or from Postgres.

This shapes several decisions you can see elsewhere in the library:

- **Stemming happens in Postgres**, using its built-in text search configurations, instead of a stemming package in TypeScript.
- **The filter JSON Schema validator is hand-written** instead of using a schema library.
- **Language detection uses Unicode script ranges**, not a detection model.
- **HTTP adapters use `fetch`** with their own timeout and retry logic.

The benefit is a small install, no transitive supply chain, and no version conflicts with your application's packages. The cost is that some components are deliberately simple. Script-based detection cannot distinguish English from French, and the `Intl.Segmenter` adapter is only as good as the runtime's dictionary. Where a better component exists, the interface lets you plug it in.

## No environment variables

The library never reads `process.env`. Every setting is an explicit constructor option or search option. That means:

- Two pipelines in one process can use different settings, such as different tenants, embedders or thresholds, without interfering.
- Configuration is visible in code review and in tests.
- How settings reach your code (environment, secret manager, configuration service) is your decision.

The example applications in the repository read environment variables. That is application code, not library code.

## Explicit over implicit

Where a silent default could produce wrong results without an error, the library asks you to decide.

- **`search` requires a query language.** It used to default to English, which quietly stemmed every other language as English.
- **The migration's embedding dimension is explicit.** `ragMigrate` defaults to 384 dimensions, so if your model produces another size, you pass `embeddingDimensions`. A mismatch fails at insert time rather than producing meaningless results.
- **Optional extensions are opt-in.** VectorChord, `pg_textsearch`, pg_bigm and RLS each need a flag on `ragMigrate`, because each needs something from your database first (an installed extension, a `shared_preload_libraries` entry, or roles and settings for RLS).

`recommendForLanguage` follows the same idea from the other direction. It is a pure lookup that returns suggested settings for a language (embedding model, dimensions, `vectorMinScore`, and whether stemming, normalization or the CJK path apply). It changes nothing by itself. You decide which suggestions to apply, and the numbers are starting points to validate on your corpus.

## What the library leaves to you

| Concern | Why it is yours | Where to start |
|---|---|---|
| Postgres installation and extensions | Extension builds, `shared_preload_libraries` and restarts are operational decisions | [Prepare PostgreSQL](/how-to/prepare-postgres) |
| Running migrations | You may already have a migration tool; the SQL files can run under it | [Run migrations](/how-to/run-migrations) |
| Database driver, pool and transactions | You already have a driver and pool; the library needs only `withConnection` and `query` | [Connect your database driver](/how-to/connect-database-driver) |
| Setting the RLS tenant on each connection | Depends on your driver's transaction API and your auth model | [Isolate tenants with RLS](/how-to/multi-tenancy-rls) |
| Hosting the embedding model and reranker | Model choice, hardware, batching and cost are deployment decisions | [Configure embeddings](/how-to/configure-embeddings), [Rerank results](/how-to/rerank) |
| Extracting text and deciding when to re-index | The library starts from text; file parsing, change detection and scheduling depend on your sources | [Chunk and index documents](/how-to/index-documents) |
| Converting metadata into typed attributes | Only you know each source's formats and conventions | [Filter by metadata](/how-to/filter-by-metadata) |
| Knowing each document's and query's language | You usually have a better signal than script-based detection | [Search multilingual content](/how-to/multilingual-search) |
| Logs, traces and metrics | The library emits through `RagLogger` and `RagTracer`; where they go is yours | [Add logging and tracing](/how-to/observability) |
| Evaluating relevance | Thresholds and weights depend on your model and corpus | [Tune relevance](/how-to/tune-relevance) |

## Related

- [How hybrid search works](/explanation/hybrid-search)
- [Interfaces reference](/reference/interfaces)
- [Go to production](/how-to/production-checklist)
