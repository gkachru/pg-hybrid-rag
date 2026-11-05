# RagPipeline

`RagPipeline` runs a hybrid search for one tenant: it prepares the query, embeds it, runs the three search legs through a [`RagDatabase`](/reference/interfaces), fuses the results, and optionally reranks them. This page covers the constructor, `search()`, `searchWithDiagnostics()`, every search option, the processing order, and what throws.

```ts
import {
  CachingStopWordsLoader,
  CachingSynonymLoader,
  PostgresRagDatabase,
  RagPipeline,
} from "pg-hybrid-rag";

const pipeline = new RagPipeline({
  tenantId,
  db: new PostgresRagDatabase(txProvider),
  embedder,
  stopWords: new CachingStopWordsLoader({ txProvider }),
  synonyms: new CachingSynonymLoader({ txProvider }),
  logger,
});

const results = await pipeline.search("how do I reset my password", { language: "en" });
```

## Constructor

<!-- no-check -->
```ts
new RagPipeline(config: RagPipelineConfig)
```

A pipeline is bound to one tenant. Create one per tenant, or one per request.

### RagPipelineConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `tenantId` | `string` | required | Tenant whose rows are searched. Passed to every provider call. With `PostgresRagDatabase` it must be a UUID string (the `tenant_id` column is `UUID`); other values fail with `invalid input syntax for type uuid`. |
| `db` | `RagDatabase` | required | Runs the three search legs. Usually a [`PostgresRagDatabase`](/reference/postgres-rag-database). |
| `embedder` | `EmbeddingProvider` | required | Embeds the query with `embedQuery()`. See [`OpenAiCompatibleEmbedder`](/reference/embedder). |
| `normalizer` | `Normalizer` | none | Lexical normalizer applied to the keyword/FTS query only, never to the embedded query. Use the same normalizer on `RagIndexer`. |
| `segmenter` | `Segmenter` | none | Word segmenter applied to the keyword/FTS query only. Use the same instance on `RagIndexer`, `Chunker` and `PostgresRagDatabase`. |
| `stopWords` | `StopWordsProvider` | none | Stop words removed from the keyword/FTS query. See [`CachingStopWordsLoader`](/reference/loaders). |
| `synonyms` | `SynonymProvider` | none | Synonym lookup passed to the FTS leg. See [`CachingSynonymLoader`](/reference/loaders). |
| `reranker` | `RerankerProvider` | none | Cross-encoder used when a search sets `rerank: true`. |
| `logger` | `RagLogger` | no-op | Receives `warn` and optional `debug` calls. |
| `tracer` | `RagTracer` | no-op | Receives the spans listed in [Tracing](#tracing). |
| `filterModel` | `FilterModelProvider` | none | Generates a metadata filter from the query when a search sets `autoFilter: true`. See [`OpenAiCompatibleFilterModel`](/reference/metadata-catalog#openaicompatiblefiltermodel). |
| `metadataCatalog` | `MetadataCatalogProvider` | none | Tenant catalog passed to the filter model. Required with `filterModel` for `autoFilter`. See [`CachingMetadataCatalog`](/reference/metadata-catalog). |
| `filterTimeoutMs` | `number` | `3000` | Total deadline in milliseconds for filter generation: catalog `describe()` plus the model call. On expiry the model's `ctx.signal` is aborted, the generated filter is dropped (`generatedFilterStatus: "error"`) and the search continues without it. `0` disables the deadline. |

The interfaces are described on [Interfaces](/reference/interfaces).

### Constructor errors

| Condition | Error |
|---|---|
| `filterTimeoutMs` is negative, not finite, or greater than `2147483647` | `Error`: `filterTimeoutMs must be a non-negative number up to 2147483647 (0 disables); got <value>` |

## Methods

### search()

<!-- no-check -->
```ts
search(query: string, options?: RagSearchOptions): Promise<RagResult[]>
```

Runs a search and returns the ranked results. Equivalent to `(await searchWithDiagnostics(query, options)).results`.

| Parameter | Type | Description |
|---|---|---|
| `query` | `string` | The user's query text. |
| `options` | `RagSearchOptions` | See [Search options](#search-options). `language` (or a single-entry `languages`) is required in practice. |

Returns `RagResult[]`, best first. Each result has `content`, `sourceType`, `sourceId`, `score`, `metadata` and `attributes`; see [Types](/reference/types). `score` is the fusion score, or the reranker's score when reranking ran.

### searchWithDiagnostics()

<!-- no-check -->
```ts
searchWithDiagnostics(
  query: string,
  options?: RagSearchOptions,
): Promise<{ results: RagResult[]; diagnostics: SearchDiagnostics }>
```

Runs the same search as `search()` and also returns how the metadata filters were handled.

| `SearchDiagnostics` field | Type | Description |
|---|---|---|
| `explicitFilter` | `FilterExpression \| null` | The `filter` option as passed, or `null`. |
| `generatedFilter` | `unknown \| null` | Raw filter-model output before validation, or `null`. |
| `generatedFilterStatus` | `"not_requested" \| "none" \| "applied" \| "invalid" \| "error"` | `not_requested`: `autoFilter` was off. `none`: the model returned `null` or `undefined`. `applied`: the generated filter passed validation and was used. `invalid`: it failed validation and was dropped. `error`: the model or catalog threw, or the deadline expired. |
| `generatedFilterErrors` | `string[]` | Present only for `invalid` (validation messages) and `error` (the error as a string). |
| `retriedWithoutGeneratedFilter` | `boolean` | `true` when the search was re-run without the generated filter (see `autoFilterRetryOnEmpty`). The status stays `applied` after a retry. |

```ts
const { results, diagnostics } = await pipeline.searchWithDiagnostics(
  "pricing pages updated this year",
  { language: "en", autoFilter: true },
);

if (diagnostics.generatedFilterStatus === "invalid") {
  logger.warn({ errors: diagnostics.generatedFilterErrors }, "Generated filter dropped");
}
```

## Search options

`RagSearchOptions` fields. All are optional at the type level.

### Query and scope

| Option | Type | Default | Description |
|---|---|---|---|
| `language` | `string` | none | Query language code (for example `"en"`, `"fr-FR"`). Selects the FTS stemming config, BM25 index group and CJK keyword path, and is passed to the normalizer and segmenter. If unset, a single-entry `languages` is used instead. If neither is set, the search throws. |
| `languages` | `string[]` | none | Restrict all three legs to rows whose `language` is in this list. Omit for cross-language search. Values must not contain a comma. |
| `sourceTypes` | `string[]` | none | Restrict all three legs to these `source_type` values. Values must not contain a comma. |
| `sourceIds` | `string[]` | none | Restrict all three legs to these `source_id` values (compared as text against the `UUID` column). Values must not contain a comma. |
| `filter` | `FilterExpression` | none | Typed attribute filter applied in all three legs. Validated before any embedding or database work. See [Filter grammar](/reference/filter-grammar). |
| `normalizer` | `{ normalize(text: string, language: string): string }` | none | Synchronous per-search query rewriter (for example abbreviation expansion). Unlike the config `normalizer`, its output feeds the embedding, the reranker and the lexical legs. |

### Retrieval and thresholds

| Option | Type | Default | Description |
|---|---|---|---|
| `topK` | `number` | `5` | Number of results to return. |
| `candidateMultiplier` | `number` | `2` | Each leg fetches up to `topK * candidateMultiplier` candidates. |
| `vectorMinScore` | `number` | `0.8` | Minimum cosine similarity for the vector leg. Rows below it are excluded before fusion. The default suits e5-family embedders; other embedders often need a lower value. Validate on your own corpus. |
| `keywordMinScore` | `number` | `0.35` | Minimum keyword-leg score: pg_trgm `word_similarity`, or query-bigram coverage on the pg_bigm (CJK) path. |

### Fusion

| Option | Type | Default | Description |
|---|---|---|---|
| `fusion` | `"rrf" \| "linear"` | `"rrf"` | `rrf`: Reciprocal Rank Fusion, rank only. `linear`: per-leg score normalization plus a weighted sum. |
| `fusionNormalizer` | `"minmax" \| "l2"` | `"minmax"` | Per-leg normalization for `fusion: "linear"`. Ignored for `rrf`. |
| `vectorWeight` | `number` | `1` | Weight of the vector leg. See the note below the table. |
| `keywordWeight` | `number` | `1` | Weight of the keyword leg. |
| `ftsWeight` | `number` | `1` | Weight of the FTS leg. |
| `rrfK` | `number` | `60` | RRF constant. A row at 1-based rank `r` in a leg contributes `weight / (rrfK + r)`. |
| `minRelevance` | `number` | none | Drop fused results scoring below `minRelevance` times the top fused score (0 to 1). `0` or unset disables it. Applied before reranking. |

A weight multiplies each row's contribution from that leg: `weight / (rrfK + rank)` for RRF, `weight * normalizedScore` for linear fusion. A weight of `0` does not disable a leg. The leg's SQL still runs and its rows still enter the fused list, with a contribution of 0 from that leg. A row found only by that leg scores 0 and can still appear in the results when fewer than `topK` rows have a positive score.

The fusion functions are also exported as `applyRRF` and `applyLinearFusion`; see [Utilities](/reference/utilities). For the trade-offs, see [Fusion and reranking](/explanation/fusion-and-reranking).

### Reranking

| Option | Type | Default | Description |
|---|---|---|---|
| `rerank` | `boolean` | `false` | Rerank the fused results with the configured `reranker`. If no reranker is configured, the search runs without reranking and does not throw. |
| `rerankCandidates` | `number` | `topK` | Number of fused candidates sent to the reranker: `max(topK, rerankCandidates)`. Bounded by what the legs return. Only used when reranking runs. |
| `rerankerMinRelativeScore` | `number` | `0.01` | Drop reranked results scoring below this fraction of the top reranked score. Skipped when the top score is not positive. `0` disables it. |
| `rerankerMinAbsoluteScore` | `number` | `0` | Drop reranked results scoring below this value, in the reranker's own units. `0` (or any value not above 0) disables it. |

The reranker is called as `reranker.rerank(naturalQuery, candidates, topK)`. The pipeline relies on the reranker to return at most `topK` results; it does not truncate the reranker's output itself. A result must clear both active floors.

### Metadata auto-filter

| Option | Type | Default | Description |
|---|---|---|---|
| `autoFilter` | `boolean` | `false` | Ask `filterModel` for a filter, validate it against the tenant catalog with `rejectUnknownKeys` and `enforceAllowedValues`, and AND it with `filter`. Requires `filterModel` and `metadataCatalog` on the config. |
| `autoFilterRetryOnEmpty` | `boolean` | `true` | When an applied generated filter leaves all three legs empty, run the legs once more with only the explicit `filter`, reusing the query embedding. |

## Processing order

`searchWithDiagnostics()` (and so `search()`) runs these steps in order:

1. **Resolve the query language.** `language`, else the single entry of `languages`. Throws if neither is set.
2. **Check filters.** Validate `filter` (throws `FilterValidationError`), then throw `AttributeFiltersUnsupportedError` if `filter` is set and `db.supportsAttributeFilters` is not `true`. With `autoFilter`, throw if `filterModel` or `metadataCatalog` is missing, then throw `AttributeFiltersUnsupportedError` if `db.supportsAttributeFilters` is not `true`. All of this happens before any embedding or database work.
3. **Load stop words** with `stopWords.loadMerged()` when the provider has it, else `stopWords.load()` merged across languages.
4. **Clean the query.** Lowercase, split on whitespace, strip trailing punctuation from each word (see `stripTrailingPunctuation` on [Utilities](/reference/utilities)), drop empty words, join with single spaces.
5. **Per-search normalizer.** Apply `options.normalizer`. If the output is blank, keep the input. The result is the *natural query*, used for the embedding and the reranker.
6. **Build the lexical query** from the natural query, for the keyword and FTS legs only:
   1. config `normalizer` (awaited),
   2. config `segmenter` (awaited),
   3. stop-word removal.

   Each step falls back to its input when its output is blank, so the lexical query is never empty because of these steps.
7. **In parallel:** embed the natural query with `embedder.embedQuery()`, load synonyms with `synonyms.load()`, and, with `autoFilter`, generate a filter from the original `query` string (bounded by `filterTimeoutMs`).
8. **Combine filters.** Explicit and generated filters are combined as `{ and: [explicit, generated] }`; either alone is used as is.
9. **Search.** Call `db.hybridSearch()` with the lexical query, the embedding, the synonym lookup, the query language, `candidateLimit = topK * candidateMultiplier`, the thresholds and the filters.
10. **Retry on empty.** If the generated filter was applied, `autoFilterRetryOnEmpty` is not `false`, and all three legs returned nothing, search again with only the explicit filter.
11. **Fuse** the vector, keyword and FTS rows (in that order, with weights `vectorWeight`, `keywordWeight`, `ftsWeight`) by RRF or linear fusion, keeping `topK` results, or `max(topK, rerankCandidates ?? topK)` when reranking runs. Rows are deduplicated by chunk id.
12. **Relevance cutoff.** Apply `minRelevance`.
13. **Rerank** when `rerank` is `true` and a reranker is configured, then apply the reranker floors. If the reranker throws, the pipeline logs a warning and returns the fused list from step 12 instead.

Stop words, synonyms, the config normalizer and the segmenter never touch the embedded query. Synonyms are expanded only by the FTS strategy; the keyword leg matches the lexical query without expansion.

## Errors

| Thrown from | Condition | Error |
|---|---|---|
| `search`, `searchWithDiagnostics` | No `language` and `languages` is not a single entry | `Error` starting `RagPipeline.search requires an explicit query language` |
| | `filter` is invalid | `FilterValidationError` (see [Errors](/reference/errors#filtervalidationerror)) |
| | `filter` or `autoFilter` is set and `db.supportsAttributeFilters !== true` | `AttributeFiltersUnsupportedError` |
| | `autoFilter` is set without both `filterModel` and `metadataCatalog` | `Error` starting `autoFilter requires both` |
| | The stop-word or synonym provider rejects | The provider's error |
| | The embedder rejects | The embedder's error, for example `EmbeddingApiError` |
| | The database rejects | The database's error. `PostgresRagDatabase` throws an `AggregateError` when any leg fails, including a comma in a `sourceTypes`, `sourceIds` or `languages` value. |

These failures do not throw:

| Failure | Behavior |
|---|---|
| Filter model or catalog throws, or `filterTimeoutMs` expires | `generatedFilterStatus: "error"`, one `logger.warn`, search continues without the generated filter. |
| Generated filter fails validation | `generatedFilterStatus: "invalid"`, one `logger.warn`, search continues without it. |
| Reranker throws | One `logger.warn` (`Reranker failed, falling back to RRF results`), fused results returned. |

## Tracing

With a `tracer`, each search opens these spans:

| Span | Attributes |
|---|---|
| `rag-pipeline.search` | `tenantId`, `topK`, `searchMode` (`hybrid-rrf-3way` or `hybrid-linear-3way`), `language`, `normalizerApplied`, `orthographicNormalizerApplied`, `segmenterApplied`, `stopWordsApplied`, `generatedFilterStatus`, `synonymsApplied`, `retriedWithoutGeneratedFilter`, `fusion`, `rerankerApplied`, `vectorCandidates`, `keywordCandidates`, `ftsCandidates`, `resultCount` |
| `rag.embedQuery` | none |
| `rag.dbSearch` | none. Opened once per database call, so twice after a retry. |
| `rag.rerank` | `inputCount`; then `outputCount` on success, or `error: true` when the reranker throws |

`normalizerApplied`, `orthographicNormalizerApplied` and `segmenterApplied` are set only when the step runs. See [Observability](/how-to/observability).

## Related

- [RagIndexer](/reference/rag-indexer)
- [PostgresRagDatabase](/reference/postgres-rag-database)
- [Tune relevance](/how-to/tune-relevance)
- [Rerank results](/how-to/rerank)
- [Generate filters automatically](/how-to/auto-filter)
- [Hybrid search](/explanation/hybrid-search)
