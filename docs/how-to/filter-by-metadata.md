# Filter search results by metadata

This guide shows how to attach typed attributes to documents when you index them and restrict a search to documents whose attributes match a filter. It also covers common filter patterns, validation errors and rows indexed before attributes existed.

For the design behind typed attributes, namespaces and type-strict matching, see [Metadata model](/explanation/metadata-model). The full grammar is in [Filter grammar](/reference/filter-grammar).

## Before you begin

- Run `ragMigrate`. Migrations 017 (the `attributes` column and its GIN index) and 018 (the key registry) apply by default.
- Use `PostgresRagDatabase` with `TsvectorFts` (the default) or `Bm25Fts`. Both apply filters in every leg. A custom `RagDatabase` or `FtsStrategy` must set `supportsAttributeFilters: true`; otherwise a filtered search throws `AttributeFiltersUnsupportedError`.

## Attach attributes when you index

Pass `attributes` to `RagIndexer.index()`. They describe the whole document and are stored on every chunk row.

```ts
import type { AttributeInput } from "pg-hybrid-rag";

declare const articleId: string; // source IDs are UUIDs

const attributes: AttributeInput[] = [
  { ns: "cms", key: "region", type: "string", format: "enum", multi: true, value: ["EU", "UK"] },
  { ns: "cms", key: "effective_date", type: "date", value: "2026-03-15" },
  { ns: "cms", key: "published", type: "boolean", value: true },
  { ns: "shop", key: "price", type: "number", format: "decimal", value: "49.90" },
  { key: "tags", type: "string", value: ["billing", "refunds"] }, // ns defaults to "global"
];

await indexer.index("article", articleId, chunks, "en", { attributes });
```

Rules the indexer enforces:

| Type | Formats | Value |
| --- | --- | --- |
| `string` | `text`, `email`, `url`, `phone`, `enum` | A string. `phone` must be E.164 (`+14155550100`). A plain string (no format, or `text`) may be a `string[]`. `enum` takes a `string[]` only with `multi: true`. |
| `number` | `float` (default), `decimal` | `float`: a finite JS number. `decimal`: a decimal string such as `"49.90"`, stored exactly. |
| `boolean` | none | `true` or `false` |
| `date` | none | `YYYY-MM-DD`, a real calendar date |
| `datetime` | none | ISO 8601 with `Z` or an offset; stored as UTC |

- Each `(ns, key)` may appear once per document. Give several values as a list.
- The indexer validates but does not coerce. Normalize phone numbers, dates and decimals before you index.
- Invalid input throws `AttributeValidationError` before any embedding call. Its `issues` array lists every problem.
- Default limits per document are 50 attributes, 20 values per attribute and 256 characters per string. Change them on the indexer:

  ```ts
  import { RagIndexer } from "pg-hybrid-rag";

  const indexer = new RagIndexer({
    tenantId,
    db,
    embedder,
    attributeLimits: { maxAttributes: 80 },
  });
  ```

  Every chunk row carries a copy of the attributes, so raising the limits grows each row.

Attributes come back on every result as `RagResult.attributes` (`[]` when a document has none).

## Pass a filter when you search

Pass a `filter` with the search. A filter is one condition, or an `and`, `or` or `not` node that combines conditions.

```ts
const results = await pipeline.search("refund window", {
  language: "en",
  filter: {
    and: [
      { ns: "cms", key: "region", op: "equals", value: "EU" },
      { ns: "cms", key: "published", op: "equals", value: true },
    ],
  },
});
```

A condition has `key`, `op` and `value`, plus optional `ns`, `type` and `caseSensitive`. Operators by type:

| Type | Operators |
| --- | --- |
| `string` | `equals`, `startsWith`, `endsWith`, `contains`, `exists` |
| `number`, `date`, `datetime` | `equals`, `gt`, `gte`, `lt`, `lte`, `between`, `exists` |
| `boolean` | `equals`, `exists` |

The filter applies inside all three search legs, together with `sourceTypes`, `sourceIds` and `languages` if you pass them.

## Common patterns

Match any of several values. `equals` with a list matches when the attribute equals any of them. A list attribute matches when any of its elements matches.

```ts
await pipeline.search("refund window", {
  language: "en",
  filter: { ns: "cms", key: "region", op: "equals", value: ["EU", "UK"] },
});
```

Filter a date range. Range operators on `YYYY-MM-DD` strings infer the `date` type.

```ts
await pipeline.search("pricing changes", {
  language: "en",
  filter: { ns: "cms", key: "effective_date", op: "between", value: ["2026-01-01", "2026-06-30"] },
});
```

Match one exact date. With `equals`, a string value is read as a `string` unless you set `type`, and a string never matches a stored date:

```ts
await pipeline.search("pricing changes", {
  language: "en",
  filter: { ns: "cms", key: "effective_date", op: "equals", value: "2026-03-15", type: "date" },
});
```

Compare datetimes. Values must carry `Z` or an offset.

```ts
await pipeline.search("outage report", {
  language: "en",
  filter: { key: "updated_at", op: "gte", value: "2026-05-01T00:00:00Z" },
});
```

Compare numbers. A JS number infers `number`. A decimal string needs `type: "number"`.

```ts
await pipeline.search("budget headphones", {
  language: "en",
  filter: {
    or: [
      { ns: "shop", key: "price", op: "lt", value: 50 },
      { ns: "shop", key: "price", op: "lt", value: "50.00", type: "number" },
    ],
  },
});
```

Both conditions above are equivalent; use whichever form your input arrives in.

Match string prefixes and substrings. Matching is case-insensitive unless `caseSensitive: true`. `%`, `_` and regex characters are literal.

```ts
await pipeline.search("setup guide", {
  language: "en",
  filter: {
    and: [
      { key: "tags", op: "startsWith", value: "bill" },
      { ns: "wiki", key: "space", op: "equals", value: "HR", caseSensitive: true },
    ],
  },
});
```

Scope by namespace. Omit `ns` (or set it to `null`) to match the key in any namespace, including `global`. Pass a list to match any of several namespaces.

```ts
await pipeline.search("escalation policy", {
  language: "en",
  filter: { ns: ["cms", "wiki"], key: "team", op: "equals", value: "support" },
});
```

Require or exclude an attribute, or exclude matching documents:

```ts
await pipeline.search("holiday schedule", {
  language: "en",
  filter: {
    and: [
      { ns: "cms", key: "effective_date", op: "exists", value: true },
      { not: { ns: "cms", key: "region", op: "equals", value: "US" } },
    ],
  },
});
```

## Validate filters from user input

`search()` validates the filter before it embeds the query or touches the database, and throws `FilterValidationError` on failure. Its `errors` array holds one message per problem; most start with the path of the bad node, such as `$.and[1]: ...`.

When the filter comes from a request, validate it first and return the errors to the caller:

```ts
import { FilterValidationError, validateFilter } from "pg-hybrid-rag";

declare const body: { query: string; filter?: unknown };

if (body.filter !== undefined) {
  const check = validateFilter(body.filter);
  if (!check.ok) {
    throw new FilterValidationError(check.errors); // or return a 400 with check.errors
  }
}
```

`search()` validates with `DEFAULT_FILTER_LIMITS` (depth 5, 32 conditions, 50 values per list, 256 characters per string). To change them, set `filterLimits` on the pipeline. It overrides only the fields you pass, and it applies to both the explicit `filter` and filters generated by `autoFilter`. Pass the same limits to your own `validateFilter` call so the two checks agree:

```ts
import { RagPipeline, validateFilter, type FilterLimits } from "pg-hybrid-rag";

declare const userFilter: unknown;

const filterLimits: Partial<FilterLimits> = { maxConditions: 64, maxListSize: 100 };
const pipeline = new RagPipeline({ tenantId, db, embedder, filterLimits });

const check = validateFilter(userFilter, { limits: filterLimits });
```

An explicit filter may name a key that no document has. It is valid and matches nothing. To reject unknown keys, validate against the tenant catalog with `validateFilter(expr, { catalog, rejectUnknownKeys: true })`; see [Generate filters from the query](/how-to/auto-filter) for the catalog.

## Gotchas

- **Type-strict matching.** A condition targets one stored type. A value stored as the string `"3"` does not match the number `3`, and a date stored as `date` does not match a `datetime` condition.
- **Case folding is `toLowerCase()` only.** It does not fold accents or `ß`, and `"İstanbul"` folds to `"i̇stanbul"`. Normalize such values yourself before indexing and filtering.
- **Legacy rows.** Rows indexed before migration 017 hold `attributes = []`. They match `not` conditions and `exists: false`, and never match a positive condition. Re-index those documents with `attributes` to make them filterable.
- **Changing attributes re-indexes the document.** There is no attribute-only update. Call `index()` again with the new attributes; it replaces the source's chunks and re-embeds them.
- **Selective filters and IVFFlat.** The approximate vector index can return fewer candidates than requested when a filter removes most of them. See [Tune the vector index](/how-to/tune-vector-index).
- **Commas in source filters.** `sourceTypes`, `sourceIds` and `languages` values must not contain commas; the adapter throws if one does. Attribute filters have no such restriction.

## Related

- [Tutorial: metadata filters](/tutorials/metadata-filters)
- [Generate filters from the query](/how-to/auto-filter)
- [Filter grammar reference](/reference/filter-grammar)
- [Errors reference](/reference/errors)
- [Metadata model](/explanation/metadata-model)
