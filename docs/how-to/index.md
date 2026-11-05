# How-to guides

How-to guides are recipes for specific tasks. They assume you know what you want to do and
have the basics working. If you're new to the library, start with the
[tutorials](/tutorials/).

## Set up

| Guide | Task |
|---|---|
| [Prepare PostgreSQL](/how-to/prepare-postgres) | Install the required and optional extensions. |
| [Run migrations](/how-to/run-migrations) | Create and upgrade the schema. |
| [Connect your database driver](/how-to/connect-database-driver) | Wire postgres.js, node-postgres or Prisma into the library. |
| [Configure embeddings](/how-to/configure-embeddings) | Choose an embedding model and connect to its API. |
| [Isolate tenants with RLS](/how-to/multi-tenancy-rls) | Enforce tenant isolation with row-level security. |

## Index content

| Guide | Task |
|---|---|
| [Chunk and index documents](/how-to/index-documents) | Split documents, index them, re-index and delete them. |
| [Manage stop words and synonyms](/how-to/stop-words-and-synonyms) | Tune query terms per tenant and language. |

## Search

| Guide | Task |
|---|---|
| [Search multilingual content](/how-to/multilingual-search) | Search content in one or many languages. |
| [Search Chinese, Japanese, Korean and Thai](/how-to/cjk-and-segmentation) | Handle scripts without spaces between words. |
| [Filter by metadata](/how-to/filter-by-metadata) | Restrict results with typed attribute filters. |
| [Generate filters from the query](/how-to/auto-filter) | Let a language model derive a filter from the query text. |
| [Rerank results](/how-to/rerank) | Reorder results with a cross-encoder. |
| [Tune relevance](/how-to/tune-relevance) | Adjust thresholds, weights and fusion, and measure the effect. |

## Scale and operate

| Guide | Task |
|---|---|
| [Use BM25 full-text search](/how-to/bm25) | Replace the default full-text ranking with BM25. |
| [Tune the vector index](/how-to/tune-vector-index) | Trade recall against speed in the vector search. |
| [Add logging and tracing](/how-to/observability) | Connect your logger and OpenTelemetry. |
| [Go to production](/how-to/production-checklist) | Check your setup before launch. |
