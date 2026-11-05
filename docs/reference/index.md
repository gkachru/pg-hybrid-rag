# Reference

Reference pages describe the library's public API and database objects: every class, option,
default, type and error. Everything documented here is exported from the `pg-hybrid-rag`
package or created by its migrations.

## Classes

| Page | Covers |
|---|---|
| [RagPipeline](/reference/rag-pipeline) | Search: configuration, `search`, `searchWithDiagnostics` and every search option. |
| [RagIndexer](/reference/rag-indexer) | Indexing, re-indexing and deleting sources. |
| [Chunker](/reference/chunker) | Splitting text into chunks by characters or tokens. |
| [PostgresRagDatabase](/reference/postgres-rag-database) | The PostgreSQL adapter and its options. |
| [FTS strategies](/reference/fts-strategies) | `TsvectorFts`, `Bm25Fts` and the `FtsStrategy` contract. |
| [OpenAiCompatibleEmbedder](/reference/embedder) | The built-in embedding client. |
| [Stop word and synonym loaders](/reference/loaders) | `CachingStopWordsLoader` and `CachingSynonymLoader`. |
| [Metadata catalog and filter model](/reference/metadata-catalog) | `CachingMetadataCatalog` and `OpenAiCompatibleFilterModel`. |

## Data and contracts

| Page | Covers |
|---|---|
| [Attributes and filter grammar](/reference/filter-grammar) | Attribute types and formats, filter syntax, operators, validation and JSON Schemas. |
| [Interfaces](/reference/interfaces) | Every provider interface you can implement. |
| [Types](/reference/types) | Exported data types. |
| [Utility functions](/reference/utilities) | Exported helper functions and constants. |
| [Errors](/reference/errors) | Every exported error class and when it's thrown. |

## Database

| Page | Covers |
|---|---|
| [ragMigrate and migrations](/reference/migrations) | The migration runner, its options, and each migration file. |
| [Schema](/reference/schema) | Tables, columns, indexes, triggers and SQL functions. |
| [Language support](/reference/languages) | Language codes and how each language is processed. |
