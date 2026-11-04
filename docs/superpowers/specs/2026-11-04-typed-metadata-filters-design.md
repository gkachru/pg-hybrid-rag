# Typed, namespaced metadata filters (with model-generated filters) — design

**Status:** approved by the owner 2026-11-04 · **Date:** 2026-11-04 · **Branch:** `feat/typed-metadata-filters`

Throughout, **(decided)** marks a choice the product owner made in conversation. **(my call)**
marks a default the design author picked; it is open to override.

## 1. Why

pg-hybrid-rag is being embedded in **Knowmax**, a customer-experience knowledge base used by
insurance, airline/travel, BFSI and telecom companies. Agents search articles, and searches need
to be narrowed by facts about the article:

- the product or line of business
- the region or market
- the fare class or plan tier
- a policy date

Two different things produce those facts:

1. **Article authors** tag articles in Knowmax.
2. **Federated content**, for example Confluence pages pulled into Knowmax, arrives with its own
   metadata. Knowmax can convert the fields it knows into real types (a Confluence date becomes a
   real date). Custom fields arrive as plain text.

Today the library stores `metadata` as an untyped `Record<string, string>`, serialized to a
`TEXT` column. It is used for display and for `Chunker.prefixFn`, and it can't be filtered. The
only filters are `sourceTypes`, `sourceIds` and `languages`.

A second goal shapes the filter language. Knowmax wants a light model that reads the user's
query and writes the filter automatically (self-query retrieval). That needs boolean logic, a
machine-checkable schema, and a way to tell the model which keys exist for each tenant.

## 2. Goals

1. Capture typed metadata per article at index time, with **no upfront schema**. The caller
   declares each field's type when it indexes the article. **(decided)**
2. Namespace every key with an `ns` so sources can't collide. A key given without an `ns` goes
   into a reserved global namespace. **(decided)**
3. Provide a filter language that both humans and models can write:
   - boolean `and` / `or` / `not` **(decided)**
   - typed conditions
   - cross-namespace matching **(decided)**
4. Enforce filters **in SQL inside every search leg** (vector, keyword, FTS), before fusion.
5. Publish a JSON Schema for the filter language, plus a validator. **(decided)**
6. Provide a per-tenant **catalog** of keys for the model to read. It combines what the library
   observes in indexed data with short descriptions Knowmax registers per key. **(decided)**
7. Provide a **pluggable filter model**: a provider, like the reranker, that turns a query into a
   filter. **(decided)**

## 3. Non-goals

- **Chunk-level metadata.** Metadata belongs to the article, and every chunk carries a copy.
  **(decided)**
- **A built-in validity / "as of" filter.** Knowmax adds articles when they take effect and
  removes them when they expire, so the index only holds what's in force. **(decided)** Effective
  and expiry dates can still be stored as ordinary date fields, and "in force on date X" can be
  expressed with `or` + `exists` if ever needed.
- **Parsing free-form values.** The library never interprets "15/03/2026" or "TBD", and never
  reformats phone numbers. Turning values into real types and canonical forms (dates, E.164
  phones, decimal strings) is the caller's job. **(decided)**
- Stemmed or full-text search *inside* metadata values. `contains` is a plain substring match.
- Facets or aggregations returned to the end user. The catalog's value counts exist to brief the
  model, not to drive UI facets.

## 4. Anti-goals: what would count as failure even if it "works"

- **Filtering in application code after retrieval.** That under-returns: each leg's top-N is cut
  before the filter runs.
- **Ingestion failing because of a type or key collision.** A federated page must never be
  rejected because a custom field shares a name with a known field.
- **A bad or unavailable filter model failing the search.**
- **SQL built by splicing user or model values into SQL, jsonpath or regex text.**
- **A model-generated filter widening what the caller's explicit filter restricted.**

## 5. Constraints (from the project)

- **Zero runtime dependencies.** The JSON Schema validator must be hand-written (no `ajv`).
  `src/` uses no npm dependencies.
- **Dependency injection and interface-first design.** The filter model is a provider passed in
  at construction, like `RerankerProvider`. The library makes no I/O of its own.
- **Parameterized SQL only.** Values go in bound parameters (or bound jsonpath `vars`). The SQL
  and jsonpath *templates* are fixed strings chosen by operator.
- **Multi-tenant.** Every table and query is scoped by `tenant_id`, and any new table follows
  migration 007's RLS pattern.
- **Driver-agnostic parameter binding.** The repo binds arrays as comma-joined text and re-splits
  them in SQL. For filters, prefer one JSON text parameter cast `::jsonb`, which avoids the comma
  restriction completely.
- **Backward compatibility.**
  - `Chunk.metadata`, `RagResult.metadata` and `prefixFn` keep working unchanged, as does the
    `metadata.language` key that `RagIndexer` uses to stamp each row's language.
  - The existing `sourceTypes`, `sourceIds` and `languages` filters keep working.
  - New migrations start at **017** and are applied by `ragMigrate`.
- Postgres 17 and pgvector ≥ 0.8.0 (iterative index scans).
- **Base branch (my call).** This branch is stacked on `chore/upgrade-db-image` (Postgres 17.11,
  pgvector 0.8.7, vchord 1.1.1), because it needs that branch's two pieces:
  - The image. All EXPLAIN and recall work runs on it; vchordrq behavior and on-disk format differ
    between 0.4.3 and 1.x.
  - `examples/benchmark/regression.ts` and its baselines, which §8 requires.

  Merge that branch first.

## 6. The design

### 6.1 Data model (the caller's view)

An indexed article may carry a list of **attributes**. Each attribute has an optional `ns`
(omitted means global), a `key`, a declared `type` and a `value`.

| type | value | notes |
|---|---|---|
| `string` | `string` or `string[]` | a list is allowed; see matching rules |
| `number` | finite number | |
| `boolean` | `true` / `false` | |
| `date` | `"YYYY-MM-DD"` | no time zone **(my call)** |
| `datetime` | ISO-8601 instant | normalized to UTC at index time **(my call)** |

- The earlier "keyword" type is merged into `string`. **(my call)** One string type with
  `equals` / `startsWith` / `endsWith` / `contains` covers both known tags (product codes) and
  Confluence custom fields.

**Formats (decided).** An attribute may also carry an optional `format`. It refines what the
value *is* without changing how it is stored or matched. It feeds the catalog, so the model knows
a key holds emails or is a multi-select enum, and it enables light shape checks at index time.

| type | format | value / index-time check |
|---|---|---|
| `string` | `text` (default) | any string |
| `string` | `email` | shape check (`local@domain`); case-folded like any string |
| `string` | `url` | must parse as an absolute URL |
| `string` | `phone` | **the caller normalizes, preferably to E.164** (`+14155550123`), like dates. The library checks the shape only (`+` and digits) and never reformats. Otherwise "+1 (415) 555-0123" and "4155550123" would never match. |
| `string` | `enum` | plus `multi: true \| false`. Single-select takes one value; multi-select takes a list. Options come from the key's registered `allowedValues` (§6.6). |
| `number` | `float` (default) | a finite JS number |
| `number` | `decimal` | **passed as a decimal string** (`"1234567.89012345"`) so precision isn't lost to JS floats. Validated against a strict decimal grammar and stored as an exact JSON number. Postgres `jsonb` numbers are arbitrary-precision `numeric`, so comparisons are exact. Filter values for decimal keys may also be decimal strings. |
| `date`, `datetime`, `boolean` | (none) | as in the table above |

- **Enum options are not enforced at index time.** **(decided)** A federated page with an
  option outside the registered list still indexes, per the anti-goal that ingestion never fails
  because of collisions. Options are enforced only on model-written filters (§6.3, §9.3).
- A failed format shape check is a caller bug and is rejected like any malformed attribute. Keep
  the checks lenient: they confirm shape, not deliverability.
- **Multi-select matching.**
  - "Has any of" uses `equals` with a list.
  - "Has all of" ANDs one `equals` per value. This works because each condition matches any
    element.
  - "Has exactly this set" is **not supported** (non-goal).
- **Types are authoritative only for their own document.** **(decided)** If one article sends
  `knowmax.effective_date` as a date and another sends it as a string, both index successfully. A
  date filter only matches the date-typed value. With namespacing, this only matters within a
  single `ns`.
- The index API rejects a malformed attribute: a value that doesn't match its declared type, an
  invalid date string, or a non-finite number. That is a caller bug, not a collision. **(my
  call)**
- The global namespace is reserved. It is addressable in filters as `ns: "global"`, a placeholder
  name **(my call)**, and a caller may not define its own `ns` with that name.
- Attributes are per article. **(decided)** The API should take them once per `index()` /
  `replaceSource()` call, not per chunk, and stamp them onto every chunk row.

### 6.2 Filter language

A filter is an expression tree. Every leaf condition has the same shape:
`{ ns, key, op, value, type, caseSensitive }`. `ns`, `type` and `caseSensitive` are optional.
**(my call)**

```jsonc
{ "and": [
    { "key": "region", "op": "equals", "value": ["EU", "UK"] },              // any ns; any of these values
    { "ns": "knowmax", "key": "effective_date", "op": "gte", "value": "2026-01-01" },
    { "not": { "ns": ["knowmax", "confluence"], "key": "cabin", "op": "equals", "value": "business" } },
    { "or": [
        { "ns": "confluence", "key": "team", "op": "startsWith", "value": "pay" },
        { "key": "priority", "op": "exists", "value": true }
    ] }
] }
```

**Why a uniform shape (my call; raised by the design review).** Strict structured-output modes
(OpenAI-style `json_schema` strict mode, and most guided-decoding servers) require:

- every property listed as required
- `additionalProperties: false`
- `anyOf` rather than `oneOf`

A condition whose operator is itself the property name (`"gte": …`) can't be expressed that way.
With a fixed set of fields and `op` as an enum, one grammar works for both:

- **Strict generation:** the published schema makes `ns`, `type` and `caseSensitive`
  nullable-required.
- **Validation:** the hand-written validator accepts them as optional, so people can hand-write
  shorter filters.

There's one grammar, not two diverging ones.

- **Boolean nodes:** `and: [...]`, `or: [...]`, `not: {...}`. **(decided)**
- **The `ns` on a condition:**
  - a single namespace
  - a list of namespaces
  - omitted, meaning **match in any namespace, including global** **(decided)**
- **String operators:** `equals`, `startsWith`, `endsWith`, `contains`. **(decided)**
  `endsWith` covers cases like "email at @acme.com".
  - Case-insensitive by default, with `caseSensitive: true` to override. **(decided)**
  - `%`, `_` and regex characters in values are literal.
  - `equals` also accepts a list, meaning "any of these". **(my call)**
- **Number, date and datetime operators:** `equals`, `gt`, `gte`, `lt`, `lte`, `between`.
  **(my call; earlier discussion assumed range operators.)**
- **Boolean operator:** `equals`.
- **`op: "exists"`** with `value: true | false`: whether the key is set in the given
  namespace(s). **(my call)**
- **List fields** match if **any** element matches. `region equals EU` matches an article tagged
  `[EU, UK]`. **(my call)**
- **Type-strict matching.** The operator and the operand's JSON type decide which stored type a
  condition targets. For example, `op: "gte"` with `value: "2026-01-01"` targets `date`, and
  `op: "gte"` with `value: 5` targets `number`. A value stored under a different type for that
  key doesn't match. **(my call; follows the per-document rule.)**
  - Conditions therefore carry an optional **`type`** (`string | number | boolean | date |
    datetime`). Inference from the value's JSON type is the fallback, but it's ambiguous for
    string-encoded values: a decimal string `"10.5"`, a date `"2026-01-01"` and a datetime are all
    JSON strings.
  - `type` is required when the value is a string meant as a number, date or datetime.
  - In the strict generation schema, `type` is a nullable-required field, like `ns`. **(my
    call)**
- **Case folding** happens in JS (`toLowerCase()`), both at index time (a stored folded copy) and
  on the filter value. It doesn't depend on database collation. **(my call)**

### 6.3 Validation and limits

- The filter grammar is exported as a JSON Schema constant, for model structured output. A
  hand-written validator returns structured errors.
- **Every filter goes through the validator before SQL generation.** That includes explicit
  filters from the caller and filters written by the model.
- **Configurable limits** stop runaway filters: maximum nesting depth, condition count, list size
  and string length. The builder picks defaults.
- **Unknown keys:**
  - In a **model-generated** filter, a key that is neither observed in the catalog nor registered
    makes the filter invalid, and the filter is dropped. **(my call)**
  - In an **explicit** filter, unknown keys are allowed and simply match nothing. The caller is
    trusted. **(my call)**
- **Registered `allowedValues`** are enforced strictly for model-generated filters: an
  out-of-list value makes the filter invalid. They are not enforced for explicit filters.
  **(decided; see §9.3)**

### 6.4 Storage and SQL (recommended; the builder may revise after EXPLAIN)

- **New column** `rag_documents.attributes JSONB NOT NULL DEFAULT '[]'`, added in migration 017.
  It is separate from the legacy `metadata TEXT` column, which keeps its display and `prefixFn`
  role.
- **Recommended encoding: an array of entries**, one entry per scalar value:

  ```json
  [{"ns":"knowmax","k":"region","t":"string","v":"EU","l":"eu"},
   {"ns":"knowmax","k":"region","t":"string","v":"UK","l":"uk"},
   {"ns":"knowmax","k":"effective_date","t":"date","v":"2026-03-15"},
   {"ns":"global","k":"priority","t":"number","v":3}]
  ```

  - A list value expands into several entries, so "any element matches" comes for free.
  - `l` holds the case-folded copy of a string value.
  - Dates and datetimes are fixed-format strings, so string comparison orders them correctly.
- **Index:** `GIN (attributes jsonb_path_ops)`.
  - Equality and `exists` compile to containment (`attributes @> $n::jsonb`), which can use the
    GIN index. For example, a case-insensitive `region equals eu` becomes
    `@> '[{"ns":"knowmax","k":"region","l":"eu"}]'`.
  - When `ns` is omitted, the `ns` field is left out of the containment object.
- **Decimals:** the stored entry holds an exact JSON number, built from the validated decimal
  string (never via a JS float), plus `"f":"decimal"`. Every entry may carry `f` (format) so the
  catalog can report it.
- **Ranges, `startsWith`, `endsWith` and `contains`** compile to residual predicates. Either
  `jsonb_path_exists(attributes, <fixed template>, $vars::jsonb)` with every value, key and `ns`
  passed in `vars`, or `EXISTS (SELECT … FROM jsonb_array_elements(attributes) …)` with bound
  parameters.
  - **Hard rule:** no key, value or pattern is spliced into SQL, jsonpath or regex text. In
    particular, jsonpath's `like_regex` only takes a literal pattern, so `contains` must not use
    it with caller values.
- **Boolean nodes** compile to parenthesized `AND` / `OR` / `NOT`.
- **The compiled clause is shared by every leg,** the same way `buildFilters` is today, and is
  appended to each leg's `WHERE`:
  - vector
  - pg_trgm or pg_bigm keyword
  - tsvector or BM25 FTS

  The existing `sourceTypes`, `sourceIds` and `languages` clauses are ANDed with it.
- **No backfill.** Rows indexed before migration 017, and articles indexed without attributes,
  have `[]`. A *positive* condition (`equals`, a range, `startsWith`, `contains`,
  `exists: true`) never matches them. But **`not {...}` and `exists: false` are true for an
  empty attribute set**, so those conditions do match untagged rows. *(Corrected after the design
  review; the earlier wording said such rows match nothing.)* The migration notes must say so,
  and the semantics must be tested. How this interacts with access control depends on the open
  question in §9.

### 6.5 Under-return in the approximate legs

A filter inside `WHERE` is applied to rows the leg's own index produced. Approximate legs can
return fewer than `candidateLimit` rows when the filter is selective.

- **IVFFlat vector leg.**
  - Add opt-in `ivfflatIterativeScan` (`relaxed_order`) and `ivfflatMaxProbes` constructor
    options, set transaction-locally through the existing `runTuned` / `set_config` path.
  - With `relaxed_order`, wrap the scan in a materialized CTE (`ORDER BY distance + 0` on PG17+)
    and re-sort outside it.
  - Apply the `vectorMinScore` floor **outside** the CTE, so the iterative scan isn't stopped
    early.
- **vchordrq.** Migration 010 builds the index flat. A flat vchordrq scan with
  `max_scan_tuples = -1` keeps scanning until `LIMIT` is satisfied, so it doesn't under-return.
  Verify this, but no change is expected.
- **BM25 (pg_textsearch).** It's unknown whether an arbitrary JSONB predicate is pushed into the
  index scan or applied after a top-K. **The builder must measure this.** If BM25 under-returns,
  the fix is in scope.
- **Planner switching.** When a filter is very selective, Postgres may switch to driving from the
  GIN index and then sorting exactly. Rely on that, but don't assume it, because JSONB selectivity
  estimates are coarse.
- **Tests.** Extend the `PG_INTEGRATION` suite with:
  - EXPLAIN checks that each leg still uses its own index when a filter is present
  - recall tests that combine a selective filter with each leg, to catch under-return

### 6.6 Catalog

- **Observed part.** Per tenant: each `ns`, key, type and **format**, with how many articles use
  it and, for strings, the most common values (a top-N of the folded values). For `enum` keys,
  the registered options take precedence over observed values in the briefing.
  - Computed from `rag_documents.attributes`, and cached per tenant with a TTL, like
    `CachingSynonymLoader`.
  - The builder decides between computing it live with a cache, and keeping a summary table
    updated on `index()` / `delete()`.
- **Registered part.** A new table, `rag_metadata_registry`, holds per tenant:
  - `ns`, `key`, `description`
  - optional `allowedValues`
  - optional `type`

  Knowmax registers keys through a library API, separately from indexing. **(my call)** The table
  is RLS-scoped like the other tenant tables.
- **The merged view** has observed and registered entries joined on `ns` + `key`. It is exported
  as a plain object, so callers can render it into their own prompts.
- **Size.** The catalog briefing for the model must stay bounded: limit the number of keys and the
  number of values per key, and prefer registered keys when there are too many.

### 6.7 Pluggable filter model

- **New interface** in `interfaces.ts`, for example
  `FilterModelProvider { generateFilter(query, catalog, ctx): Promise<FilterExpression | null> }`.
  `null` means the query implies no filter.
- **Default adapter (my call).** `OpenAiCompatibleFilterModel`: a fetch-based client for any
  OpenAI-compatible chat endpoint. It sends the published JSON Schema as structured output, and
  has the same timeout, retry and response-shape checks as `OpenAiCompatibleEmbedder`. The prompt
  template lives in the adapter. Knowmax can replace the whole adapter with its own fine-tuned
  model.
- **Search integration.**
  - `RagSearchOptions` gains `filter?: FilterExpression` and an opt-in for the filter model, for
    example `autoFilter?: boolean`.
  - An explicit filter and a generated one are **ANDed**. **(my call)** The model can narrow a
    search, never widen it.
- **Failure handling (my call).**
  - A generated filter that fails validation or times out is dropped. The search continues
    without it, and the event is logged through the existing logger.
  - The generated filter is included in the search result or debug output, so it can be
    inspected.
- **Empty-result retry (decided; see §9.3).** On by default and configurable. When a valid
  generated filter yields zero results, the search re-runs once without it, and the result
  records the retry. The explicit filter is never dropped.
- **Ordering.** Filter generation can run concurrently with query embedding. Both have to finish
  before the legs run.

### 6.8 Custom `RagDatabase` / `FtsStrategy` implementations (fail closed)

Consumers may implement `RagDatabase` or `FtsStrategy` themselves, test doubles included. The new
filter therefore travels as an **optional** field on `HybridSearchParams` and `FtsContext`. That
keeps existing implementations compiling, but an implementation that doesn't know about the field
would silently return **unfiltered** rows.

So the design fails closed **(my call)**:

- Implementations declare support, for example a `supportsAttributeFilters: true` property on
  `RagDatabase` and on `FtsStrategy`.
- `RagPipeline` / `PostgresRagDatabase` **throw** when a filter is present and the target doesn't
  declare support.
- The bundled `PostgresRagDatabase`, `TsvectorFts` and `Bm25Fts` declare it.
- The release is a minor version bump (0.5.x → 0.6.0), with a changelog note on the capability
  flag.

### 6.9 Results

- `RagResult` gains `attributes`, the typed entries, alongside the unchanged `metadata`. The
  builder chooses the exact public shape. It should mirror the indexing input, not the storage
  encoding.

## 7. Left to the builder

- Exact public type names and API signatures (`index()` option shape, filter operator spelling,
  the `datetime` targeting syntax).
- The final storage encoding and SQL forms, chosen by EXPLAIN on the integration image, as long
  as the hard rules in §4, §5 and §6.4 hold.
- Default limits, the catalog cache TTL, top-N sizes, and the default adapter's prompt.
- Whether the catalog's observed part is computed live with a cache or kept in a summary table.
- How to split the work into phases. A natural order is:
  1. storage and filters
  2. iterative scans and under-return tests
  3. catalog and registry
  4. the filter model

## 8. Testing expectations

- **Unit tests** for:
  - the validator, including limits and unknown keys
  - the filter-to-SQL compiler: the SQL text, the parameter order, and proof that no value
    reaches the SQL or jsonpath text
  - attribute normalization (folding, UTC, list expansion)
  - catalog merging
  - the default adapter (mocked `fetch`)
- **Integration tests** (`PG_INTEGRATION`): each leg × filter type returns correct rows, legs
  still use their own indexes, and the selective-filter recall tests from §6.5.
- **Benchmark regression** (`examples/benchmark/regression.ts`): with no filter, results must
  match the baselines. That shows the extra column and the clause plumbing change nothing when no
  filter is used.
- **Fail-closed tests** (§6.8): a filter plus an implementation that doesn't declare support must
  throw.

## 9. Owner answers (from the design review)

1. **Filters narrow results for relevance. They are not access control.** **(decided)**
   - The semantics in §6.4 stand: `not` / `exists: false` match untagged and pre-017 rows, and
     that's documented behavior, not a leak.
   - Dropping an invalid *model* filter is acceptable.
   - An invalid *explicit* filter still throws, because it's a caller bug.
   - The fail-closed check in §6.8 stays as a correctness safeguard.
2. **Deployment shape: one database per tenant, at most about 20k articles per tenant (about 5k
   on average).** **(decided)** Attributes per article are unknown.
   - **Under-return work (§6.5) is fully in scope.** With a single tenant per database, the
     tenant btree never narrows anything, so the ANN and BM25 indexes always drive their legs. A
     selective attribute filter is exactly the under-return case. The multi-tenant
     "planner skips the ANN index" behavior can't be relied on here.
   - **Expected scale.** About 20k articles × several chunks each means roughly 25k–200k rows
     *(estimate; chunks per article not measured)*. Integration and recall tests should run at the
     top of that range, on real embeddings for recall (synthetic vectors can't measure recall).
   - **Catalog (my call).** At this size, compute the observed part live with a per-tenant cache,
     not a summary table. Use a longer TTL than the synonym cache (minutes, not 30 s), because the
     key set changes slowly. Add a per-article attribute cap with a clear error at index time,
     because the attribute count is unknown. The builder picks the default cap and checks it
     against the catalog query's cost.
3. **Plausible but wrong model filters.** **(decided)** Applies to filters the model wrote, not
   explicit ones.
   - **Registered `allowedValues` are enforced strictly.** A model filter that uses a value
     outside a key's registered list is invalid and is dropped, and the search runs without it.
     Example: the model writes `region = "Europe"` but the registered values are `EU`, `UK`.
   - **The empty-result retry is on by default** and can be turned off by configuration. If a
     valid model filter returns zero results, the search re-runs once without it. The result is
     marked as retried, together with the dropped filter, for logs and debugging.
   - Neither rule ever applies to the caller's explicit filter. It is always ANDed in and never
     retried away.
