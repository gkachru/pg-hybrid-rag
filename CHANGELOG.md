# Changelog

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
  every matched row. Equal-score ties may be returned in a different order than before.
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
