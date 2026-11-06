# Types

This page describes the data types exported from `pg-hybrid-rag` (most are defined in `src/types.ts`). Types that belong to one class or function are documented with it; the [index](#where-other-types-are-documented) at the end points to them.

```ts
import type { RagResult, RagSearchOptions, SearchDiagnostics } from "pg-hybrid-rag";
```

## Search results

### RagResult

One search result, as returned by `RagPipeline.search` and passed to a `RerankerProvider`.

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | The chunk text as indexed (raw, not normalized). |
| `sourceType` | `string` | Source type given at index time. |
| `sourceId` | `string \| null` | Source ID given at index time. |
| `score` | `number` | Fusion score (RRF or linear), or the reranker's score when reranking ran. Comparable only within one result list. |
| `metadata` | `Record<string, string>` | The chunk's metadata, parsed from the stored JSON. `{}` when the stored value is missing or not a JSON object. |
| `attributes` | `AttributeOutput[]` | Typed attributes of the source. `[]` when there are none. |

### RagSearchOptions

Per-search options for `RagPipeline.search` and `searchWithDiagnostics`: result count, thresholds, weights, fusion, source and language scoping, `filter`, `autoFilter`, and reranking. All options, defaults and validation rules are listed in [RagPipeline: Search options](/reference/rag-pipeline#search-options).

### SearchDiagnostics

Returned by `RagPipeline.searchWithDiagnostics` alongside the results. Describes how the explicit and generated metadata filters were handled.

| Field | Type | Description |
|-------|------|-------------|
| `explicitFilter` | `FilterExpression \| null` | The `filter` option as passed, or `null`. |
| `generatedFilter` | `unknown \| null` | Raw, unvalidated output of the filter model, or `null`. |
| `generatedFilterStatus` | `"not_requested" \| "none" \| "applied" \| "invalid" \| "error"` | `not_requested`: `autoFilter` was off. `none`: the model returned no filter. `applied`: a valid generated filter was used. `invalid`: it failed validation and was dropped. `error`: the model or catalog failed or timed out. |
| `generatedFilterErrors` | `string[]` (optional) | Validation errors (`invalid`) or the error message (`error`). |
| `retriedWithoutGeneratedFilter` | `boolean` | `true` when an applied generated filter left all three legs empty and the search ran again with only the explicit filter. `generatedFilterStatus` stays `"applied"` in that case. |

### FusionMethod

`"rrf" | "linear"`. How the search legs are combined: Reciprocal Rank Fusion (rank only) or a weighted sum of per-leg normalized scores. See [`applyRRF`](/reference/utilities#applyrrf) and [`applyLinearFusion`](/reference/utilities#applylinearfusion).

### FusionNormalizer

`"minmax" | "l2"`. Per-leg score normalization used by linear fusion. Ignored for RRF.

## Search internals

These types cross the boundary between `RagPipeline` and a `RagDatabase` or `FtsStrategy`. You need them when you implement those interfaces or call the fusion functions directly.

### HybridSearchParams

Passed by `RagPipeline` to `RagDatabase.hybridSearch`.

| Field | Type | Description |
|-------|------|-------------|
| `tenantId` | `string` | Tenant to search. |
| `embeddingStr` | `string` | Query embedding as a pgvector text literal, `[a,b,c,...]`. |
| `query` | `string` | Lexical query for the keyword and full-text legs (normalized, segmented, stop words removed). |
| `synonymLookup` | `SynonymLookup` | Synonyms for query expansion. Empty map when no `SynonymProvider` is configured. |
| `language` | `string` | Resolved query language. |
| `candidateLimit` | `number` | Rows per leg: `topK * candidateMultiplier`. |
| `vectorMinScore` | `number` | Minimum cosine similarity for the vector leg. |
| `keywordMinScore` | `number` | Minimum keyword-leg score. |
| `sourceTypes` | `string[]` (optional) | Restrict to these source types. |
| `sourceIds` | `string[]` (optional) | Restrict to these source IDs. |
| `languages` | `string[]` (optional) | Restrict to rows in these languages. |
| `attributeFilter` | `ValidatedFilter` (optional) | Validated attribute filter to apply in every leg. |
| `skipLegs` | `readonly SearchLeg[]` (optional) | Legs disabled because their weight is `0`. Set only when at least one leg is disabled. An adapter should return `[]` for these legs without querying; the pipeline also discards their rows. |

### SearchLeg

`"vector" | "keyword" | "fts"`. One of the three hybrid search legs. Used by `HybridSearchParams.skipLegs`.

### RankedCandidate

One row from a search leg, before fusion. Each leg returns these best first.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Chunk ID (`rag_documents.id`). Fusion deduplicates candidates by this value. |
| `content` | `string` | Chunk text. |
| `sourceType` | `string` | Source type. |
| `sourceId` | `string \| null` | Source ID. |
| `metadata` | `string` | Metadata as JSON text. |
| `attributes` | `string` (optional) | Attributes as JSON text (`attributes::text`). Treated as `"[]"` when absent. |
| `score` | `number` (optional) | The leg's own relevance score (cosine similarity, `word_similarity`, bigram coverage, `ts_rank_cd`, or BM25). RRF ignores it; linear fusion uses it, treating a missing score as 0. |

### SynonymLookup

`Map<string, Map<string, string[]>>`: language code, then term, then its expansion terms. Query expansion merges all languages into one map and keeps at most 5 expansions per term. Produced by a `SynonymProvider`.

## Indexing

### Chunk

A text chunk produced by a `ChunkingProvider` and consumed by `RagIndexer.index`.

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | Chunk text. |
| `index` | `number` | Position of the chunk within the source. Stored as `chunk_index`. |
| `metadata` | `Record<string, string>` | Stored as JSON in `rag_documents.metadata` and returned as `RagResult.metadata`. A `language` entry sets the row's language. |

```ts
import type { Chunk } from "pg-hybrid-rag";

const manual: Chunk[] = [
  { content: "Reset your password from the sign-in page.", index: 0, metadata: { language: "en" } },
];
```

### StopWordRow

A row of `rag_stop_words` as read by `CachingStopWordsLoader`.

| Field | Type |
|-------|------|
| `language` | `string` |
| `word` | `string` |

### SynonymRow

A row of `rag_synonyms` as read by `CachingSynonymLoader`.

| Field | Type | Description |
|-------|------|-------------|
| `language` | `string` | Language code. |
| `term` | `string` | The term to expand. |
| `synonyms` | `string[] \| string` | JSONB column: a parsed array or raw JSON text, depending on the driver. |
| `direction` | `"two_way" \| "one_way"` | `two_way` also maps each synonym back to the term. |

## Attributes

The validation rules for these types are in [Filter grammar](/reference/filter-grammar#attributes).

| Type | Definition |
|------|------------|
| `AttributeType` | `"string" \| "number" \| "boolean" \| "date" \| "datetime"` |
| `AttributeFormat` | `"text" \| "email" \| "url" \| "phone" \| "enum" \| "float" \| "decimal"`. `string` takes the first five; `number` takes `float` and `decimal`. |
| `AttributeInput` | `{ ns?: string; key: string; type: AttributeType; format?: AttributeFormat; multi?: boolean; value: string \| number \| boolean \| string[] }`. Attribute as passed to `RagIndexer.index`. |
| `AttributeOutput` | `{ ns: string; key: string; type: AttributeType; format?: AttributeFormat; value: string \| number \| boolean \| string[] }`. Attribute as returned in `RagResult.attributes`. |
| `StoredAttributeEntry` | `{ ns: string; k: string; t: AttributeType; f?: AttributeFormat; v: string \| number \| boolean; l?: string; s?: string; m?: true }`. One stored scalar; see [Storage encoding](/reference/filter-grammar#storage-encoding). |
| `AttributeLimits` | `{ maxAttributes: number; maxValuesPerAttribute: number; maxStringLength: number }`. Defaults in `DEFAULT_ATTRIBUTE_LIMITS`. |

## Filters

The grammar and semantics are in [Filter grammar](/reference/filter-grammar#filter-expressions).

| Type | Definition |
|------|------------|
| `FilterOp` | `"equals" \| "startsWith" \| "endsWith" \| "contains" \| "gt" \| "gte" \| "lt" \| "lte" \| "between" \| "exists"` |
| `FilterScalar` | `string \| number \| boolean` |
| `FilterCondition` | `{ ns?: string \| string[] \| null; key: string; op: FilterOp; value: FilterScalar \| FilterScalar[]; type?: AttributeType \| null; caseSensitive?: boolean \| null }` |
| `FilterExpression` | `FilterCondition \| { and: FilterExpression[] } \| { or: FilterExpression[] } \| { not: FilterExpression }` |
| `FilterLimits` | `{ maxDepth: number; maxConditions: number; maxListSize: number; maxStringLength: number }`. Defaults in `DEFAULT_FILTER_LIMITS`. |
| `ValidatedFilter` | Output of `validateFilter`; see [ResolvedCondition](/reference/filter-grammar#resolvedcondition). |
| `ResolvedCondition` | A normalized condition; see [ResolvedCondition](/reference/filter-grammar#resolvedcondition). |
| `FilterValidationOptions` | Options of `validateFilter`; see [FilterValidationOptions](/reference/filter-grammar#filtervalidationoptions). |

## Metadata catalog

### MetadataCatalog

Returned by `MetadataCatalogProvider.describe`.

| Field | Type | Description |
|-------|------|-------------|
| `tenantId` | `string` | Tenant the catalog describes. |
| `generatedAt` | `string` | Time the catalog was built. |
| `keys` | `CatalogKey[]` | One entry per `(ns, key)`. |

### CatalogKey

One key in a tenant catalog: registry information merged with what is observed in indexed data.

| Field | Type | Description |
|-------|------|-------------|
| `ns` | `string` | Namespace. |
| `key` | `string` | Key. |
| `registered` | `boolean` | `true` when the key is in `rag_metadata_registry`. |
| `description` | `string` (optional) | Registered description. |
| `declaredType` | `AttributeType` (optional) | Registered type. |
| `declaredFormat` | `AttributeFormat` (optional) | Registered format. |
| `multi` | `boolean` (optional) | Registered `multi` flag. |
| `allowedValues` | `string[]` (optional) | Registered allowed values (string keys only). Used by `enforceAllowedValues`. |
| `observed` | `Array<{ type: AttributeType; format?: AttributeFormat; articleCount: number }>` | One row per observed type and format. Counts are distinct sources, not chunks. Empty for a registered key not yet seen in data. |
| `topValues` | `Array<{ value: string; articleCount: number }>` (optional) | Most common string values by source count. |

### RegisteredKeyInput

A key passed to `CachingMetadataCatalog.register`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ns` | `string` | No | Defaults to `"global"`. |
| `key` | `string` | Yes | Key name. |
| `description` | `string` | Yes | Non-empty description, shown to the filter model. |
| `type` | `AttributeType` | No | Declared type. |
| `format` | `AttributeFormat` | No | Declared format; requires `type`. |
| `multi` | `boolean` | No | Declared multi flag; requires `format: "enum"`. |
| `allowedValues` | `string[]` | No | Non-empty list of unique strings. Only for string keys (or keys without a declared type). |

See [CachingMetadataCatalog](/reference/metadata-catalog) for registration behavior.

## Where other types are documented

| Type | Page |
|------|------|
| `RagPipelineConfig` | [RagPipeline](/reference/rag-pipeline) |
| `RagIndexerConfig` | [RagIndexer](/reference/rag-indexer) |
| `ChunkerConfig` | [Chunker](/reference/chunker) |
| `PostgresRagDatabaseOptions` | [PostgresRagDatabase](/reference/postgres-rag-database) |
| `OpenAiCompatibleEmbedderConfig` | [Embedder](/reference/embedder) |
| `CachingStopWordsLoaderConfig`, `CachingSynonymLoaderConfig` | [Loaders](/reference/loaders) |
| `CachingMetadataCatalogConfig`, `OpenAiCompatibleFilterModelConfig` | [Metadata catalog](/reference/metadata-catalog) |
| `MigrateOptions` | [Migrations](/reference/migrations#migrateoptions) |
| `LanguageRecommendation`, `ArabicNormalizeOptions`, `IntlSegmenterAdapterConfig`, `SearchFilters`, `BuiltFilters` | [Utilities](/reference/utilities) |
| Provider interfaces (`SqlClient`, `EmbeddingProvider`, ...) | [Interfaces](/reference/interfaces) |
