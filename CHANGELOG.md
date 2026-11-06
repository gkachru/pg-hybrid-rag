# Changelog

## Unreleased

### Fixed

- `ragMigrate` locates the package's `sql/` directory when `sqlDir` is omitted (ESM and CJS, Node
  and Bun). 0.6.0 threw "Could not auto-detect SQL directory" whenever it was installed as a
  package. A missing directory now throws an error naming the path.
- Reranking returns at most `topK` results: reranked output is sorted by score and capped, and the
  fallback after a reranker error is the fused top-`topK` (it could return up to
  `max(topK, rerankCandidates)`).
- `RagIndexer.index()` with an empty chunk list deletes the source's existing chunks (it returned 0
  and left them searchable).
- A leg weight of `0` disables the leg: the adapter skips its query and none of its candidates are
  fused. Previously the leg still ran and its candidates could fill the tail of the results.
- `recommendForLanguage` reports `stemming` and `isCjk` for the exact language code, matching
  `rag_fts_config()`, the BM25 groups and the adapter's CJK routing (`pt-BR` → `"none"`,
  `zh-TW` → `isCjk: false`). `needsNormalization` still uses the base code.
- `OpenAiCompatibleEmbedder` sends the text unchanged when `queryPrefix` or `documentPrefix` is
  `""` (it sent `": text"`).
- `PostgresRagDatabase` validates `ivfflatProbes` (positive integer) in the constructor.
- `CachingStopWordsLoader` / `CachingSynonymLoader`: a load in flight during `invalidate()` no
  longer writes its stale result into the cache.
- The `stopWordsApplied` span attribute and log field are true only when a stop word was removed.
- Thai: `normalizeForLanguage` / `LanguageNormalizer` drop mai yamok (ๆ), with any whitespace
  before it, from the indexed `content_normalized` and the lexical query, so attached, spaced
  and omitted forms match in the keyword leg. Paiyannoi (ฯ) is no longer stripped from query
  words, so `กรุงเทพฯ` and `ฯลฯ` match documents as written. Re-index Thai sources to normalize
  their stored text.
- `Chunker.chunk()`: overlap is carried into a following paragraph that is split by sentences, and
  a buffer holding only carried overlap is no longer emitted as a duplicate chunk.

### Added

- `RagPipelineConfig.filterLimits` overrides the filter validation limits for explicit and
  generated filters.
- `HybridSearchParams.skipLegs` and the `SearchLeg` type (set by the pipeline for zero-weight legs).
- Migration `020_stop_words_unique.sql` (default): removes duplicate stop words and adds a unique
  index on `(tenant_id, language, word)`.
- Migration `021_force_rls.sql` (with `rls: true`): `FORCE ROW LEVEL SECURITY` on the four tenant
  tables.

### Breaking

- With `rls: true`, migration 021 makes the tenant policies apply to the table owner. An
  application that connects as the (non-superuser) owner must set `app.current_tenant_id`, or it
  sees no rows. Superusers and `BYPASSRLS` roles are still exempt.
- Re-indexing text whose last paragraph is split by sentences no longer produces the trailing
  overlap-only chunk, so chunk counts and indexes can differ from 0.6.0 for such sources.

## 0.6.0

### Added

- Typed, namespaced article attributes: `RagIndexer.index(..., { attributes })`, stored in
  `rag_documents.attributes` and returned as `RagResult.attributes` (`[]` when none). Default
  limits per article: 50 attributes, 20 values per list attribute, 256 characters per string value
  (`DEFAULT_ATTRIBUTE_LIMITS`; override with `RagIndexerConfig.attributeLimits`).
- Explicit metadata filters: `RagSearchOptions.filter` (`and` / `or` / `not` trees of
  `{ ns, key, op, value, type, caseSensitive }` conditions), validated before any embedding or SQL
  work and applied in all three search legs.
- Tenant metadata catalog: `CachingMetadataCatalog` (`register`, `unregister`, `describe`).
- Optional auto-filter: `RagSearchOptions.autoFilter`, `RagPipelineConfig.filterModel` /
  `metadataCatalog`, `OpenAiCompatibleFilterModel`, `RagPipeline.searchWithDiagnostics` and
  `SearchDiagnostics`. Retry without the generated filter when all legs are empty
  (`autoFilterRetryOnEmpty`, default true).
- `RagPipelineConfig.filterTimeoutMs` (default 3000, `0` disables): total deadline for generated-filter
  derivation (catalog `describe()` + model call). On timeout the generated filter is dropped with
  status `"error"` and the search proceeds. `FilterModelContext.signal` is aborted on timeout;
  `OpenAiCompatibleFilterModel` cancels its in-flight request and does not retry after it.
- `OpenAiCompatibleFilterModel` option `maxTokens` (sent as `max_tokens`; omitted when unset).
- `PostgresRagDatabase` options `ivfflatIterativeScan` (`"off"` | `"relaxed_order"`) and
  `ivfflatMaxProbes`.
- Migrations: `017` (`attributes` column + GIN index), `018` (`rag_metadata_registry`), `019`
  (registry RLS, applied only with `{ rls: true }`). 017 and 018 apply by default.

### Changed

- Performance: the tsvector FTS, pg_trgm keyword and pg_bigm keyword legs now cast `attributes` to
  text above the `LIMIT` (outer query), so the cast runs on at most `candidateLimit` rows instead of
  every matched row.
- The pg_trgm, pg_bigm and tsvector legs break equal-score ties by
  `source_type, source_id, chunk_index, id`, both before and after the `LIMIT`. Tied rows used to
  come back in physical order, which a schema or data-layout change could reshuffle. Ties now order
  the same way on every run, which can differ from the old order. The vector and BM25 legs are
  unchanged (an extra sort key would stop their index from returning rows in order).
- Performance: with `ivfflatIterativeScan: "relaxed_order"` and no `ivfflatMaxProbes`,
  `ivfflat.max_probes` now defaults to `4 * ivfflatProbes` (40 by default) instead of unbounded. Very
  selective filters may return fewer rows; set `ivfflatMaxProbes` explicitly to raise the cap.
- Performance: the per-leg planner GUCs are applied in a single `set_config` statement (one round trip).
- Performance: the catalog's observed-keys and top-values queries now collapse to distinct
  `(source_type, source_id, attributes)` rows before expanding attributes, instead of expanding every
  chunk row. Results are unchanged; about 25-45% faster on a 100k-row, 5-chunks-per-article corpus.
- `CachingMetadataCatalog.describe` is now stale-while-revalidate: past `ttlMs` it returns the cached
  catalog immediately and refreshes in the background (one refresh at a time; a failed refresh keeps
  the stale entry and is retried by a later call). The first load per tenant, and the first load
  after `register` / `unregister` / `invalidate`, still waits.
- `RagResult` gains a required `attributes: AttributeOutput[]` field. Code that constructs
  `RagResult` values (for example test doubles) must add it.
- `RagDatabase` and `FtsStrategy` gain an optional `supportsAttributeFilters` flag. Custom
  implementations fail closed: a search that passes a filter throws
  `AttributeFiltersUnsupportedError` unless the implementation sets `supportsAttributeFilters: true`
  and applies the filter in every leg. Searches without a filter are unaffected.

- `insertChunks` / `replaceSource` rows on `RagDatabase` and `PostgresRagDatabase` take an optional
  `attributes` string (serialized JSON); it defaults to `"[]"` when omitted.
- `RankedCandidate` gains `attributes`, and `RagResult` carries `attributes` (see above).
- `RagIndexer.index` takes an optional fifth `options` parameter (`{ attributes }`).
- Custom `RagDatabase` implementations must persist `attributes` and return
  `attributes::text AS attributes` from every search leg. Otherwise attribute filters and the
  catalog see no data.

### Notes

- No backfill: rows indexed before upgrading hold `attributes = []`. They match `not {...}` and
  `exists: false` conditions but no positive condition until re-indexed with attributes.
- Case-insensitive string matching uses JS `toLowerCase()` and does not fold accents or `ß`.
