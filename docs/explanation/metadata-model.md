# The metadata model

This page explains how typed attributes work: why each attribute declares its own type and namespace, why matching is type-strict, how case folding works, why filters run inside every search leg and fail closed, how rows without attributes behave, and why a model-generated filter is validated and ANDed with yours.

## Two kinds of metadata

A chunk can carry two unrelated kinds of metadata.

| | `metadata` | `attributes` |
|---|---|---|
| Shape | `Record<string, string>`, per chunk | Typed, namespaced values, per article |
| Stored in | `metadata` text column | `attributes` JSONB column, GIN-indexed |
| Filterable | No | Yes, with `filter` on `search` |
| Used for | Display, `Chunker` `prefixFn`, the per-chunk `language` | Narrowing a search |

`metadata` predates attribute filters and keeps its role. Attributes were added as a separate column so that filtering could have types, validation and an index without changing what existing callers store.

## Attributes belong to the article

You pass attributes once per `RagIndexer.index` call, and every chunk row of that source gets the same copy. A filter is a statement about the document ("published in 2026", "region is EU"), not about a passage, so per-article is the natural granularity. Copying the value onto each chunk keeps filtering a simple per-row predicate, at the cost of storage proportional to the number of chunks. The default limits (50 attributes, 20 values per attribute, 256 characters per string) bound that cost per row.

## No schema up front, types declared per value

There is no schema to register before indexing. Each attribute you index states its own type (`string`, `number`, `boolean`, `date` or `datetime`) and, optionally, a format (`email`, `url`, `phone`, `enum`, `decimal`, and others). The library validates the value against that type and stores a canonical form:

- **Dates** must be `YYYY-MM-DD` and real calendar dates.
- **Datetimes** must include a time zone and are stored as UTC ISO strings.
- **Decimals** are written as exact JSON numbers from the validated string, never through a JavaScript float, so precision is preserved.
- **Phone numbers** (format `phone`) must already be in E.164 form.

The library never parses free-form values such as "15/03/2026" or "next Tuesday". Converting source data into real types is the caller's job, because only the caller knows what a source's conventions are. Rejecting at index time means a bad value fails loudly once, instead of silently never matching later.

Canonical storage is also what makes ranges simple. Dates and UTC datetimes in fixed-width ISO form sort correctly as strings, so a date range is a string comparison. Numbers are compared as `numeric`.

## Namespaces

Every attribute has a namespace (`ns`). An attribute indexed without one goes into the reserved `global` namespace. Namespaces let different sources use the same key name without colliding. A `cms` source and a `crm` source can both have a `status` key with different meanings and types, and both index successfully.

A filter condition can name one namespace, a list of namespaces, or none. Without `ns`, the condition matches the key in any namespace, including `global`. This lets you filter on a concept shared across sources ("region is EU") without enumerating every source.

```ts
import type { FilterExpression } from "pg-hybrid-rag";

const filter: FilterExpression = {
  and: [
    { ns: "cms", key: "region", op: "equals", value: ["EU", "UK"] },
    { key: "effective_date", op: "gte", value: "2026-01-01" }, // any namespace
  ],
};
```

## Type-strict matching

A condition matches only attributes of the same type. The string `"5"` does not match the number `5`, and a date does not match a string that happens to look like a date. The one exception is `exists`, which checks only that the key is present, whatever its type.

Loose matching would make results depend on how each source happened to encode a value, and would make an index-friendly SQL form much harder. Type-strict matching keeps equality a single JSON containment test that the GIN index can serve.

You rarely have to state the type in a filter. The validator infers it from the values: numbers mean `number`, booleans mean `boolean`, and strings mean `string`, except with range operators, where strings that are all valid dates or all valid zoned datetimes are inferred as `date` or `datetime`. When inference is ambiguous, validation fails and asks you to set `type`.

## Case folding

String equality and the substring operators are case-insensitive by default. At index time, each string attribute stores the original value and a folded copy made with JavaScript `toLowerCase()`. A case-insensitive condition compares against the folded copy, and `caseSensitive: true` compares against the original.

Folding is only `toLowerCase()`. It does not remove accents or apply full Unicode case folding: `café` does not match `cafe`, and `STRASSE` folds to `strasse`, which does not match `straße`. This keeps the rule predictable and identical in TypeScript and in the stored data. If you need accent-insensitive matching, store a normalized form as its own attribute.

## How a filter becomes SQL

`search` validates the filter before any embedding or database work and compiles it into one parameterized clause that is added to every leg's `WHERE`.

- **`equals` and `exists`** compile to JSONB containment (`attributes @> ...`), which the `idx_rag_attributes` GIN index can serve. A list of values becomes an OR of containment tests.
- **Ranges, `startsWith`, `endsWith` and `contains`** compile to an `EXISTS` over the row's attribute entries. These are checked per candidate row rather than looked up in the index.
- **`and`, `or` and `not`** compile to the matching SQL operators.

Keys, namespaces and values are always bound as parameters, never spliced into the SQL text.

### Why filters run inside every leg

Filtering after fusion would under-return. Each leg has already cut its results to `candidateLimit` rows by the time fusion runs, so a selective filter applied afterwards could leave few or no results even though matching rows exist further down each leg. Applying the filter inside each leg's `WHERE` clause means each leg ranks only rows that pass.

The approximate vector index has its own version of this problem: it may stop scanning before it finds enough rows that pass a selective filter. See [Indexes and performance](/explanation/indexes-and-performance) for IVFFlat iterative scans.

## Fail closed

A filter is often a restriction the caller depends on, sometimes for correctness, sometimes because certain content must not appear. A component that silently ignored the filter would return rows the caller explicitly excluded.

So support is opt-in and checked. A `RagDatabase` and an `FtsStrategy` must declare `supportsAttributeFilters: true` to receive a filter. If you pass a filter (or enable `autoFilter`) and the configured database or FTS strategy does not declare support, the search throws `AttributeFiltersUnsupportedError` instead of running unfiltered. The bundled `PostgresRagDatabase`, `TsvectorFts` and `Bm25Fts` declare support. A custom implementation written before attribute filters existed keeps compiling, but is refused for filtered searches until it applies the filter and sets the flag.

## Rows without attributes

Rows indexed before the `attributes` column existed, and articles indexed without attributes, store an empty list. The migration does not backfill them. An empty list:

- never matches a positive condition (`equals`, ranges, `startsWith`, `endsWith`, `contains`, `exists: true`);
- always matches `exists: false` and the negation of any positive condition.

That follows from the logic: an article with no `region` attribute is not in region EU, so `not (region equals EU)` is true for it. It has a practical consequence. A filter written as an exclusion, such as `not (visibility equals internal)`, includes every untagged row. If you use attributes to keep content out of results, write the filter as an inclusion (`visibility equals public`), or re-index older content with attributes first.

## Model-generated filters

With `autoFilter: true`, a `FilterModelProvider` reads the user's query and a description of the tenant's metadata (the catalog) and proposes a filter. For "refund policy for EU customers", it might propose `region equals EU`. This is often called self-query retrieval.

A language model's output is untrusted input, so the pipeline constrains it.

**It is validated against the catalog.** The generated filter must pass the same validation as yours, plus two catalog checks: every key must exist in the tenant's catalog, and an `equals` on a string key with registered allowed values must use one of them. A model cannot introduce a key the tenant does not have, or a value outside a registered list. Values for keys without a registered list are not checked, which is one reason to register allowed values for keys with a fixed set of options.

**It is ANDed with your filter.** The final filter is `explicit AND generated`. A conjunction can only narrow a result set, so the model can never widen what your explicit filter restricted, whatever it returns.

**It never fails the search.** If the model times out (the default deadline is 3 seconds for the catalog lookup and model call together), throws, or returns an invalid filter, the pipeline logs a warning, drops the generated filter, and searches with your explicit filter alone. `searchWithDiagnostics` reports what happened in `generatedFilterStatus`.

**An empty result triggers one retry.** If a valid generated filter leaves all three legs empty, it was more likely a wrong guess than a true empty answer. The pipeline searches once more with only your explicit filter, reusing the query embedding. Your explicit filter is never dropped. Set `autoFilterRetryOnEmpty: false` to disable this.

Filter generation runs concurrently with the query embedding, so it adds latency only when it takes longer than the embedding call.

Your explicit filter is not checked against the catalog. An unknown key in an explicit filter is valid: a positive condition on it matches nothing, and its negation matches every row. To check explicit filters against the catalog, call `validateFilter` yourself with the `rejectUnknownKeys` option.

## Related

- [Filter by metadata](/how-to/filter-by-metadata)
- [Generate filters from the query](/how-to/auto-filter)
- [Attributes and filter grammar](/reference/filter-grammar)
- [Metadata catalog and filter model](/reference/metadata-catalog)
