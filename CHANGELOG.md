# Changelog

## 0.6.0

### Added

- Typed, namespaced article attributes: `RagIndexer.index(..., { attributes })`, stored in
  `rag_documents.attributes` and returned as `RagResult.attributes` (`[]` when none).
- Explicit metadata filters: `RagSearchOptions.filter` (`and` / `or` / `not` trees of
  `{ ns, key, op, value, type, caseSensitive }` conditions), validated before any embedding or SQL
  work and applied in all three search legs.
- Tenant metadata catalog: `CachingMetadataCatalog` (`register`, `unregister`, `describe`).
- Optional auto-filter: `RagSearchOptions.autoFilter`, `RagPipelineConfig.filterModel` /
  `metadataCatalog`, `OpenAiCompatibleFilterModel`, `RagPipeline.searchWithDiagnostics` and
  `SearchDiagnostics`. Retry without the generated filter when all legs are empty
  (`autoFilterRetryOnEmpty`, default true).
- `PostgresRagDatabase` options `ivfflatIterativeScan` (`"off"` | `"relaxed_order"`) and
  `ivfflatMaxProbes`.
- Migrations: `017` (`attributes` column + GIN index), `018` (`rag_metadata_registry`), `019`
  (registry RLS, applied only with `{ rls: true }`). 017 and 018 apply by default.

### Changed

- `RagResult` gains a required `attributes: AttributeOutput[]` field. Code that constructs
  `RagResult` values (for example test doubles) must add it.
- `RagDatabase` and `FtsStrategy` gain an optional `supportsAttributeFilters` flag. Custom
  implementations fail closed: a search that passes a filter throws
  `AttributeFiltersUnsupportedError` unless the implementation sets `supportsAttributeFilters: true`
  and applies the filter in every leg. Searches without a filter are unaffected.

### Notes

- No backfill: rows indexed before upgrading hold `attributes = []`. They match `not {...}` and
  `exists: false` conditions but no positive condition until re-indexed with attributes.
- Case-insensitive string matching uses JS `toLowerCase()` and does not fold accents or `ß`.
