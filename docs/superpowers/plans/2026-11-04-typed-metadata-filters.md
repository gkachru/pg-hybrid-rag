# Typed Metadata Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typed, namespaced per-article attributes that can be filtered inside every search leg,
using a filter language that people or a pluggable model can write, with a per-tenant catalog
that briefs the model.

**Architecture:**
- Attributes are normalized in TypeScript and stored as an array of entries in a new
  `attributes JSONB` column, with a GIN index.
- A validated filter expression compiles into one parameterized SQL clause. That clause is
  appended to the `WHERE` of the vector, keyword and FTS legs, through the existing
  `buildFilters` path.
- The catalog merges observed attributes with a registry table.
- The filter model is a provider, called concurrently with query embedding. Its filter is ANDed
  with the caller's explicit filter.

**Tech Stack:** TypeScript (strict, ES2022), Bun (`bun:test`), Biome, Postgres 17.11,
pgvector 0.8.7, vchord 1.1.1, pg_textsearch 1.3.0, pg_trgm, pg_bigm. Zero runtime npm
dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-typed-metadata-filters-design.md`. Read it first;
section numbers (§) below refer to it.

## Global Constraints

- **Zero runtime dependencies in `src/`.** The JSON Schema validator is hand-written (no `ajv`).
- **Parameterized SQL only.** No key, `ns`, value or pattern is ever spliced into SQL text.
  - All attribute-filter parameters are bound as **text**, with casts in SQL (`::jsonb`,
    `::numeric`), which keeps binding driver-agnostic.
  - jsonpath `like_regex` must never be used.
- **Backward compatibility.** `Chunk.metadata`, `RagResult.metadata`, `prefixFn`, the
  `metadata.language` row stamp and the `sourceTypes` / `sourceIds` / `languages` filters
  behave exactly as before. With no attribute filter, every leg's `WHERE` clause and parameters
  are byte-identical to today; the only SQL change is the added `attributes::text AS attributes`
  column in each leg's `SELECT` (Task 2).
- **Global namespace.** It is named `"global"` (`GLOBAL_NS`).
  - In **attribute input**, an explicit `ns: "global"` is the same as omitting `ns`.
  - In **filters**, an omitted / `null` `ns` means *any* namespace, while `ns: "global"` means
    only the global namespace (spec §6.2).
- **Case folding** uses `String.prototype.toLowerCase()` in JS, applied both at index time and
  to filter values. Never use SQL `lower()`.
- **Fail closed.** If an attribute filter is present and the target `RagDatabase` or
  `FtsStrategy` lacks `supportsAttributeFilters === true`, throw.
- **New migrations** are `017_attributes.sql`, `018_metadata_registry.sql` and
  `019_metadata_registry_rls.sql`. The 019 file name contains `rls`, so `ragMigrate` only
  applies it with `{ rls: true }`. The file names must not contain `cjk`, `vectorchord` or
  `textsearch`.
- **Version:** `package.json` 0.5.0 → **0.6.0**.
- **Branch:** `feat/typed-metadata-filters`, stacked on `chore/upgrade-db-image`. The
  integration image is `examples/Dockerfile` from that branch.
- **Commands:**
  - Unit: `bun test <file>`
  - Quality gate: `bun run typecheck`, `bun run lint`, `bun test`
  - Integration: `PG_INTEGRATION=1 POSTGRES_PORT=<compose db port> bun test tests/integration/<file>`
    (env from `examples/.env`)
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

These five inputs are implied by the spec but aren't exercised by any task's main tests. Each is
pinned by a test in the task named in brackets.

1. **Non-ASCII values.** "İstanbul" (Turkish dotted İ), "Straße", Arabic and Thai values must
   match themselves case-insensitively, because the same JS folding runs at index time and
   query time. [Task 1, Task 6]
2. **Values with SQL or JSON metacharacters** (`%`, `_`, `'`, `"`, `\`, `$1`, `)--`) match
   literally and never change the SQL text. [Task 4, Task 6]
3. **Untagged and legacy rows** (`attributes = '[]'`) match `not {...}` and `exists: false`, and
   no positive condition. [Task 4, Task 6]
4. **Re-indexing an article with changed attributes** removes the old attributes completely
   (`replaceSource`), so a stale value can't still match. [Task 6]
5. **Decimals beyond float precision** (`"12345678901234567890.123"`), negative numbers and
   datetimes with non-UTC offsets compare exactly and in UTC. [Task 1, Task 6]

---

## Phase 1 — Storage and explicit filters

### Task 1: Attribute types and normalization

**Files:**
- Modify: `src/types.ts` (append the attribute types)
- Create: `src/metadata/attributes.ts`
- Modify: `src/index.ts` (exports)
- Test: `tests/attributes.test.ts`

**Interfaces:**
- Produces, in `src/types.ts`:
  ```ts
  export type AttributeType = "string" | "number" | "boolean" | "date" | "datetime";
  export type AttributeFormat = "text" | "email" | "url" | "phone" | "enum" | "float" | "decimal";
  export interface AttributeInput {
    ns?: string; key: string; type: AttributeType; format?: AttributeFormat; multi?: boolean;
    value: string | number | boolean | string[];
  }
  export interface AttributeOutput {
    ns: string; key: string; type: AttributeType; format?: AttributeFormat;
    value: string | number | boolean | string[];
  }
  /** One stored scalar (internal storage encoding, spec §6.4). */
  export interface StoredAttributeEntry {
    ns: string; k: string; t: AttributeType; f?: AttributeFormat;
    v: string | number | boolean; // decimal: the exact numeric literal (serialized raw)
    l?: string;                   // folded copy, strings only
    s?: string;                   // decimal: original decimal string, for exact output
    m?: true;                     // entry came from a list value
  }
  export interface AttributeLimits { maxAttributes: number; maxValuesPerAttribute: number; maxStringLength: number; }
  ```
- Produces, in `src/metadata/attributes.ts`:
  - `GLOBAL_NS = "global"`
  - `DEFAULT_ATTRIBUTE_LIMITS: AttributeLimits = { maxAttributes: 200, maxValuesPerAttribute: 100, maxStringLength: 1024 }`
  - `class AttributeValidationError extends Error { readonly issues: string[] }`
  - `normalizeAttributes(input: AttributeInput[], limits?: Partial<AttributeLimits>): StoredAttributeEntry[]`
    collects *all* issues, then throws `AttributeValidationError` if there are any.
  - `serializeAttributes(entries: StoredAttributeEntry[]): string`
  - `parseAttributes(json: string): AttributeOutput[]`
  - `foldCase(s: string): string`
  - `normalizeDatetime(s: string): string` returns `Date#toISOString()` and throws on a naive
    datetime (one without `Z` or an offset).
  - `isValidDate(s: string): boolean` checks `YYYY-MM-DD` and that it's a real calendar date.
  - `isDecimalString(s: string): boolean` tests `/^-?(0|[1-9]\d*)(\.\d+)?$/`.

**Rules to implement (spec §6.1):**
- Allowed format per type: `text` / `email` / `url` / `phone` / `enum` → `string`;
  `float` / `decimal` → `number`. Any other combination is an issue.
- `multi` is only valid with `enum`. Single enum takes a scalar; `multi: true` takes a
  `string[]`.
- A plain `string` with `text` (the default) or no format accepts a string or `string[]`.
- Format shape checks:
  - `email`: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
  - `url`: `new URL(v)` must succeed
  - `phone`: E.164, `/^\+[1-9]\d{6,14}$/`
- `decimal` values must be decimal strings. `float` (the default for `number`) must be a finite
  JS number.
- `date` uses `isValidDate`. `datetime` uses `normalizeDatetime`.
- `ns` and `key` must be non-empty and at most 128 chars. A missing `ns` becomes `GLOBAL_NS`.
- Each `string[]` element becomes one entry with `m: true`.
- Strings get `l: foldCase(v)`. Decimals get `v` = the literal and `s` = the original string.
- **`serializeAttributes`** builds JSON with `JSON.stringify` per entry, except that a decimal
  entry's `v` is written as the raw validated literal, so its precision survives.
- **`parseAttributes`** regroups entries by `ns` + `k` + `t`:
  - An entry group with `m: true` produces a `string[]`.
  - Decimals output `s` (a string).
  - Order: first appearance.

- [ ] **Step 1: Write the failing tests** in `tests/attributes.test.ts`, with these cases and
  exact expectations:
  - `normalizeAttributes([{ key: "region", type: "string", value: ["EU", "UK"] }])` equals
    `[{ns:"global",k:"region",t:"string",v:"EU",l:"eu",m:true},{ns:"global",k:"region",t:"string",v:"UK",l:"uk",m:true}]`.
  - `{ ns: "kx", key: "price", type: "number", format: "decimal", value: "12345678901234567890.123" }`
    becomes an entry whose serialized JSON contains `"v":12345678901234567890.123` and
    `"s":"12345678901234567890.123"`. `parseAttributes(serializeAttributes(...))[0].value`
    is `"12345678901234567890.123"`.
  - Datetime `"2026-03-15T10:00:00+05:30"` stores `v: "2026-03-15T04:30:00.000Z"`. Datetime
    `"2026-03-15T10:00:00"` (naive) is an issue.
  - `foldCase("İstanbul") === "İstanbul".toLowerCase()`, and folding Arabic "مرحبا" leaves it
    unchanged.
  - Each of the following throws `AttributeValidationError`, with `issues.length >= 1`:
    - `{type:"string", format:"decimal"}`
    - `{type:"number", value:"10.5"}` (no decimal format)
    - phone `"4155550123"`
    - email `"region@"`
    - `{format:"enum", multi:true, value:"EU"}`
    - date `"2026-02-30"`
    - 201 attributes
    - an empty key
  - A mixed input with two bad attributes produces exactly 2 issues, so all issues are reported,
    not just the first.
  - Round trip: `parseAttributes(serializeAttributes(normalizeAttributes(input)))` deep-equals
    the outputs, with `ns: "global"` filled in, for a list, an enum single, a boolean and a date.

- [ ] **Step 2: Run them and confirm they fail.**
  Run `bun test tests/attributes.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement the types and `src/metadata/attributes.ts`** per the rules above.
  Export `GLOBAL_NS`, `DEFAULT_ATTRIBUTE_LIMITS`, `AttributeValidationError`,
  `normalizeAttributes`, `serializeAttributes` and `parseAttributes`, plus the types, from
  `src/index.ts`.
- [ ] **Step 4: Run them and confirm they pass.**
  Run `bun test tests/attributes.test.ts`. Expected: PASS. Then run `bun run typecheck && bun run lint`.
- [ ] **Step 5: Commit** with message `feat(metadata): typed attribute normalization + storage encoding`.

### Task 2: Store and return attributes (migration 017, indexer, legs, results)

**Files:**
- Create: `sql/017_attributes.sql`
- Modify: `src/interfaces.ts` (insert row type), `src/RagIndexer.ts`,
  `src/adapters/PostgresRagDatabase.ts` (`buildInsert`, the leg `SELECT` lists),
  `src/adapters/fts/TsvectorFts.ts`, `src/adapters/fts/Bm25Fts.ts`,
  `src/adapters/sqlHelpers.ts` (`toRankedCandidate`), `src/types.ts` (`RankedCandidate`,
  `RagResult`), `src/fusionShared.ts`
- Test: `tests/indexer.test.ts`, `tests/postgresRagDatabase.test.ts`,
  `tests/fusionShared.test.ts`, `tests/migrate.test.ts`

**Interfaces:**
- Consumes (from Task 1): `normalizeAttributes`, `serializeAttributes`, `parseAttributes`,
  `DEFAULT_ATTRIBUTE_LIMITS`, `AttributeInput`, `AttributeLimits`.
- Produces:
  - The insert/replace chunk row type in `RagDatabase.insertChunks` / `replaceSource` gains
    `attributes: string` (serialized JSON, `"[]"` when there are none).
  - `RagIndexer.index(sourceType, sourceId, chunks, language = "en", options?: { attributes?: AttributeInput[] }): Promise<number>`
  - `RagIndexerConfig.attributeLimits?: Partial<AttributeLimits>`
  - `RankedCandidate.attributes?: string` (raw JSON text)
  - `RagResult.attributes: AttributeOutput[]`, always present, `[]` when there are none.

**Migration 017:**
- `ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '[]'::jsonb;`
- `CREATE INDEX IF NOT EXISTS idx_rag_attributes ON rag_documents USING gin (attributes jsonb_path_ops);`
- A header comment saying there's no backfill, and the §6.4 semantics: legacy rows are `[]`;
  they match `not` / `exists: false` and no positive condition.

**Wiring:**
- `RagIndexer` normalizes once per `index()` call, before embedding, so invalid attributes throw
  before any embedding cost. It stamps the same serialized string on every row.
- `buildInsert` inserts `$n::jsonb`.
- Every leg `SELECT` adds `attributes::text AS attributes`.
- `toRankedCandidate` maps `row.attributes` (defaulting to `"[]"`).
- `fusionShared` sets `attributes: parseAttributes(candidate.attributes ?? "[]")`. A malformed
  value becomes `[]`, mirroring `parseMetadata`.

- [ ] **Step 1: Write the failing tests:**
  - `tests/indexer.test.ts`: with a mocked `RagDatabase`, `index("faq", id, chunks, "en", { attributes: [{ key: "region", type: "string", value: "EU" }] })`
    passes rows to `replaceSource` whose `attributes` all equal the same string, which contains
    `"k":"region"`.
  - Another indexer test: `index` without options passes `attributes: "[]"`.
  - Another indexer test: invalid attributes reject with `AttributeValidationError`, and
    `embedDocuments` is never called.
  - `tests/postgresRagDatabase.test.ts`: the captured INSERT SQL contains `attributes` and
    `::jsonb`, and each leg's captured SELECT contains `attributes::text AS attributes`.
  - `tests/fusionShared.test.ts`: a candidate with an attributes JSON string yields
    `RagResult.attributes` deep-equal to the parsed outputs. A candidate without the field
    yields `[]`.
  - `tests/migrate.test.ts`: `017_attributes.sql` is applied with default options.
- [ ] **Step 2: Run them and confirm they fail.**
  Run `bun test tests/indexer.test.ts tests/postgresRagDatabase.test.ts tests/fusionShared.test.ts tests/migrate.test.ts`.
  Expected: the new cases FAIL.
- [ ] **Step 3: Implement the migration and wiring** above. Update any existing test fixtures
  that build insert rows to include `attributes`.
- [ ] **Step 4: Run the full quality gate.**
  Run `bun test && bun run typecheck && bun run lint`. Expected: everything passes, with no
  existing test changed except for added `attributes` fields.
- [ ] **Step 5: Commit** with message `feat(metadata): store attributes per article and return them on results`.

### Task 3: Filter types, JSON Schema and validator

**Files:**
- Modify: `src/types.ts` (filter types)
- Create: `src/metadata/filterSchema.ts`
- Modify: `src/index.ts`
- Test: `tests/filterSchema.test.ts`

**Interfaces:**
- Consumes (from Task 1): `AttributeType`, `GLOBAL_NS`, `isValidDate`, `normalizeDatetime`,
  `isDecimalString`, `foldCase`.
- Produces, in `src/types.ts`:
  ```ts
  export type FilterOp = "equals" | "startsWith" | "endsWith" | "contains"
    | "gt" | "gte" | "lt" | "lte" | "between" | "exists";
  export type FilterScalar = string | number | boolean;
  export interface FilterCondition {
    ns?: string | string[] | null; key: string; op: FilterOp;
    value: FilterScalar | FilterScalar[]; type?: AttributeType | null; caseSensitive?: boolean | null;
  }
  export type FilterExpression = FilterCondition | { and: FilterExpression[] } | { or: FilterExpression[] } | { not: FilterExpression };
  export interface FilterLimits { maxDepth: number; maxConditions: number; maxListSize: number; maxStringLength: number; }
  ```
- Produces, in `src/metadata/filterSchema.ts`:
  - `DEFAULT_FILTER_LIMITS: FilterLimits = { maxDepth: 5, maxConditions: 32, maxListSize: 50, maxStringLength: 256 }`
  - `FILTER_JSON_SCHEMA`: a lenient draft 2020-12 schema in which `ns`, `type` and
    `caseSensitive` are optional.
  - `FILTER_GENERATION_SCHEMA`: strict-compatible. The root is
    `{ type:"object", properties:{ filter:{ anyOf:[{$ref:"#/$defs/expr"},{type:"null"}] } }, required:["filter"], additionalProperties:false }`.
    Every object has every property listed in `required`, with `ns` / `type` / `caseSensitive`
    allowing `null`. It uses `anyOf` (never `oneOf`), `additionalProperties: false`, and
    recursion through `$defs` / `$ref`.
  - `interface ResolvedCondition { ns: string[] | null; key: string; op: FilterOp; type: AttributeType; values: FilterScalar[]; caseSensitive: boolean }`
    Values are already normalized: strings are folded unless case-sensitive, datetimes are
    UTC ISO strings, decimals are kept as strings, and `between` has `[lo, hi]`. `ns: null`
    means any namespace.
  - `type ValidatedFilter = ResolvedCondition | { and: ValidatedFilter[] } | { or: ValidatedFilter[] } | { not: ValidatedFilter }`
  - `validateFilter(expr: unknown, options?: FilterValidationOptions): { ok: true; filter: ValidatedFilter } | { ok: false; errors: string[] }`
  - `interface FilterValidationOptions { limits?: Partial<FilterLimits> }`. Task 10 extends it.
  - `class FilterValidationError extends Error { readonly errors: string[] }`
  - `assertValidFilter(expr: unknown, options?: FilterValidationOptions): ValidatedFilter`
    throws `FilterValidationError`.

**Type resolution and operator rules (spec §6.2):**
- An explicit `type` wins.
- Otherwise:
  - A number value means `number`. A boolean value means `boolean`.
  - A string with `equals` / `startsWith` / `endsWith` / `contains` means `string`.
  - A string with `gt` / `gte` / `lt` / `lte` / `between` means `date` if every value passes
    `isValidDate`, otherwise `datetime` if every value parses with an explicit offset or `Z`,
    otherwise it's an error ("set `type`").
  - A decimal string used as a number requires `type: "number"`.
- Allowed operators per type:
  - `string`: `equals`, `startsWith`, `endsWith`, `contains`, `exists`
  - `number`, `date`, `datetime`: `equals`, `gt`, `gte`, `lt`, `lte`, `between`, `exists`
  - `boolean`: `equals`, `exists`
- Value shape per operator:
  - `exists` takes a boolean, and its `type` is ignored.
  - `between` takes exactly 2 values, and `lo <= hi`.
  - `equals` takes a scalar or a non-empty list.
  - Every other operator takes a scalar.
- A filter's `ns` is normalized to `string[] | null`:
  - Omitted or `null` → `null` (any namespace, global included).
  - A single string → a one-element list.
  - `"global"` is a normal value, matching only the global namespace.
- Limits:
  - Depth counts the boolean nesting.
  - Conditions counts leaves.
  - List size applies to `equals` lists and `ns` lists.
  - String length applies to `key`, `ns` and string values.
- Unknown properties are errors, and empty `and` / `or` arrays are errors.

- [ ] **Step 1: Write the failing tests** in `tests/filterSchema.test.ts`:
  - The spec §6.2 example filter, in uniform shape, validates `ok: true`. Its resolved
    `effective_date` leaf has `type: "date"`, and its `region` leaf has `values: ["eu","uk"]`
    and `ns: null`.
  - `{key:"price", op:"gte", value:"10.5"}` → `ok: false`, with an error mentioning `type`.
    With `type:"number"` it is `ok: true` and `values: ["10.5"]`.
  - `{key:"t", op:"gte", value:"2026-03-15T10:00:00+05:30"}` resolves to `datetime` with
    `values: ["2026-03-15T04:30:00.000Z"]`.
  - Each of these → `ok: false`:
    - `{key:"a", op:"contains", value:5}`
    - `{key:"a", op:"between", value:[5,1]}`
    - `{and:[]}`
    - an unknown property `"foo"`
    - depth 6
    - 33 leaf conditions
    - a 51-element `equals` list
  - `caseSensitive:true` keeps `values: ["EU"]` unfolded.
  - `FILTER_GENERATION_SCHEMA` structure check: walk every object schema and assert that
    `additionalProperties === false`, that `required` contains every key of `properties`, and
    that no `oneOf` appears anywhere.
- [ ] **Step 2: Run them and confirm they fail.**
  Run `bun test tests/filterSchema.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `src/metadata/filterSchema.ts`** and the types. Export the schema
  constants, `validateFilter`, `assertValidFilter`, `FilterValidationError`,
  `DEFAULT_FILTER_LIMITS` and the types from `src/index.ts`.
- [ ] **Step 4: Run them and confirm they pass.**
  Run `bun test tests/filterSchema.test.ts && bun run typecheck && bun run lint`. Expected:
  PASS.
- [ ] **Step 5: Commit** with message `feat(metadata): filter expression grammar, JSON Schemas and validator`.

### Task 4: Filter → SQL compiler

**Files:**
- Create: `src/metadata/compileFilter.ts`
- Test: `tests/compileFilter.test.ts`

**Interfaces:**
- Consumes (from Task 3): `ValidatedFilter`, `ResolvedCondition`. Also `BuiltFilters` from
  `sqlHelpers.ts`.
- Produces: `compileAttributeFilter(filter: ValidatedFilter, startIdx: number): BuiltFilters`.
  The return is `{ clause: "AND (<expr>)", params: string[] }`. Every parameter is a string.

**SQL forms (fixed templates; `$n` are bound parameters):**
- **Equality and `exists: true`.** Uses `attributes @> $n::jsonb`.
  - The parameter is a JSON array with one object built from:
    - `k`
    - `t`: omitted for `exists`
    - `l` for case-insensitive strings, or `v` for case-sensitive strings and for
      number / boolean / date / datetime
    - `ns`: only when exactly one `ns` is given
  - Decimal literals are written raw into this JSON text, the same way `serializeAttributes`
    writes them.
  - Multiple values or multiple namespaces become an OR of containments.
- **`exists: false`.** `NOT (<the exists: true form>)`.
- **Ranges, `startsWith`, `endsWith`, `contains`:**
  - The shape is `EXISTS (SELECT 1 FROM jsonb_array_elements(attributes) e WHERE e->>'k' = $a AND e->>'t' = $b [AND e->>'ns' IN (SELECT jsonb_array_elements_text($c::jsonb))] AND <cmp>)`.
  - `<cmp>` by type:
    - **number:** `(CASE WHEN e->>'t' = 'number' THEN (e->>'v')::numeric END) <op> $x::numeric`.
      The CASE guard matters because Postgres doesn't guarantee the order in which `AND` terms
      are evaluated.
    - **date / datetime:** `e->>'v' <op> $x` (the stored and query strings share one fixed
      format).
    - **between:** `>= $lo AND <= $hi`.
    - **startsWith:** `starts_with(e->>'l', $x)`, using `v` when case-sensitive.
    - **endsWith:** `right(e->>'l', length($x)) = $x`.
    - **contains:** `strpos(e->>'l', $x) > 0`.
- **Boolean nodes:** `(a AND b)`, `(a OR b)`, `NOT (a)`.

- [ ] **Step 1: Write the failing tests** in `tests/compileFilter.test.ts`, driven by
  `assertValidFilter(...)` then `compileAttributeFilter(f, 5)`:
  - `{key:"region", op:"equals", value:"EU"}` →
    `{ clause: "AND (attributes @> $5::jsonb)", params: ['[{"k":"region","t":"string","l":"eu"}]'] }`.
  - With `ns:"kx"`, the parameter includes `"ns":"kx"`. With `ns:["a","b"]`, the clause has
    two containments joined by `OR`.
  - `{key:"price", type:"number", op:"gte", value:"10.50"}`: the clause contains `::numeric`
    and the CASE guard, and the params include `"10.50"`.
  - `{not:{key:"x", op:"exists", value:true}}` → the clause starts with `AND (NOT (`.
  - **Injection safety:** for each value in `["%", "_", "'", "\"", "\\", "$1", ")--", "a' OR '1'='1"]`
    used as a `contains` value, the clause text never contains the value. Assert the clause is
    identical across all of them, so only the parameters differ.
  - Parameter numbering starts at `startIdx`, and the number of placeholders equals
    `params.length`.
- [ ] **Step 2: Run them and confirm they fail.**
  Run `bun test tests/compileFilter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `compileAttributeFilter`** with the fixed templates above.
- [ ] **Step 4: Run them and confirm they pass.**
  Run `bun test tests/compileFilter.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(metadata): compile validated filters to parameterized SQL`.

### Task 5: Wire explicit filters into all legs, fail closed

**Files:**
- Modify: `src/adapters/sqlHelpers.ts`, `src/types.ts` (`HybridSearchParams`,
  `RagSearchOptions`), `src/interfaces.ts` (`FtsContext`, `FtsStrategy`, `RagDatabase`),
  `src/adapters/PostgresRagDatabase.ts`, `src/adapters/fts/TsvectorFts.ts`,
  `src/adapters/fts/Bm25Fts.ts`, `src/RagPipeline.ts`, `src/index.ts`
- Test: `tests/sqlHelpers.test.ts`, `tests/postgresRagDatabase.test.ts`,
  `tests/tsvectorFts.test.ts`, `tests/bm25Fts.test.ts`, `tests/pipeline.test.ts`

**Interfaces:**
- Consumes (from Tasks 3–4): `assertValidFilter`, `compileAttributeFilter`, `ValidatedFilter`,
  `FilterExpression`.
- Produces:
  - `SearchFilters.attributeFilter?: ValidatedFilter`. `buildFilters` appends the compiled
    clause *after* the `sourceTypes` / `sourceIds` / `languages` clauses, continuing their
    parameter numbering.
  - `HybridSearchParams.attributeFilter?: ValidatedFilter` and
    `FtsContext.attributeFilter?: ValidatedFilter`
  - `RagDatabase.supportsAttributeFilters?: boolean` and
    `FtsStrategy.supportsAttributeFilters?: boolean`
  - `TsvectorFts` and `Bm25Fts` set `readonly supportsAttributeFilters = true`.
  - `PostgresRagDatabase` exposes a `get supportsAttributeFilters(): boolean` that returns
    `this.fts.supportsAttributeFilters === true`.
  - `class AttributeFiltersUnsupportedError extends Error`, exported.
  - `RagSearchOptions.filter?: FilterExpression`

**Behavior:**
- `RagPipeline.search` calls `assertValidFilter(opts.filter)` when a filter is given. An
  invalid explicit filter throws `FilterValidationError` (spec §9.1).
- If there's a filter and `this.db.supportsAttributeFilters !== true`, it throws
  `AttributeFiltersUnsupportedError`.
- It passes the validated filter as `attributeFilter`.
- `PostgresRagDatabase.hybridSearch` also throws `AttributeFiltersUnsupportedError` when an
  `attributeFilter` is set and the FTS strategy lacks support.
- `PostgresRagDatabase` forwards `attributeFilter` to the FTS context.

- [ ] **Step 1: Write the failing tests:**
  - `sqlHelpers.test.ts`: `buildFilters({ languages:["en"], attributeFilter: f }, 5)` has the
    `languages` clause at `$5` and the attribute clause starting at `$6`.
  - `postgresRagDatabase.test.ts`:
    - The vector, keyword (trgm and bigm) and FTS legs' captured SQL each contain
      `attributes @>` when a filter is set.
    - With no filter, the SQL equals a snapshot taken *before* this change. Capture it in this
      step, first.
    - A custom `FtsStrategy` without the flag, given a filter, makes `hybridSearch` reject with
      `AttributeFiltersUnsupportedError`.
  - `pipeline.test.ts`:
    - An invalid `filter` rejects with `FilterValidationError` before `embedQuery` is called.
    - A mocked `RagDatabase` lacking the flag, given a filter, rejects with
      `AttributeFiltersUnsupportedError`.
    - A valid filter reaches `hybridSearch` as a validated filter.
- [ ] **Step 2: Run them and confirm they fail.**
  Run `bun test tests/sqlHelpers.test.ts tests/postgresRagDatabase.test.ts tests/pipeline.test.ts tests/tsvectorFts.test.ts tests/bm25Fts.test.ts`.
  Expected: the new cases FAIL.
- [ ] **Step 3: Implement the wiring** above.
- [ ] **Step 4: Run the full quality gate.**
  Run `bun test && bun run typecheck && bun run lint`. Expected: everything passes.
- [ ] **Step 5: Commit** with message `feat(metadata): apply attribute filters inside every search leg; fail closed`.

### Task 6: Integration tests — correctness and index use

**Files:**
- Modify: `tests/integration/pgHarness.ts`. `SeedSpec` rows gain an optional
  `attributes?: AttributeInput[]`, and `seed` writes `serializeAttributes(normalizeAttributes(...))`.
- Create: `tests/integration/attributeFilters.test.ts`, gated by `RUN_INTEGRATION`.

**Interfaces:** Consumes the harness (`createTestDb`, `seed`, `explain`, `usedIndexes`,
`pickCaptured`) and everything from Tasks 1–5.

**Test corpus (all migrations applied, plus `vectorchord`, `bm25` and `cjk`):**
- Articles tagged with:
  - `region` (multi-enum EU/UK/US)
  - `effective_date`
  - a decimal `price`
  - a `team` string, including "İstanbul ops" and an Arabic value
  - a boolean `vip`
  - a Confluence-namespace `effective_date` as a string, to test collisions
- Two untagged articles (`attributes = '[]'`).
- Content shared, so every leg can find every article.

- [ ] **Step 1: Write the integration tests**, each running a real `RagPipeline.search` through
  the adapter. Each assertion is on the returned article ids:
  - One test per operator × type: `equals`, its list form, `startsWith`, `endsWith`,
    `contains` and `caseSensitive`; number ranges with decimals (including
    `"12345678901234567890.123"` and negative values); date and datetime `between`, with an
    offset input; boolean `equals`; `exists` true and false.
  - Cross-namespace: no `ns` matches both the Knowmax and Confluence `effective_date`, and
    `ns:"kx"` matches only Knowmax. A date range never matches the string-typed Confluence
    value.
  - `not {region equals EU}` and `exists:false` include the two untagged articles. A positive
    condition never does.
  - The metacharacter values from Review Focus #2 stored literally are found by `equals`.
  - Re-index (Review Focus #4): re-index article A without `region`. `region equals EU` no
    longer returns A.
  - EXPLAIN: with a filter, each leg still uses its own index:
    - vector → `idx_rag_embedding_vchordrq`
    - keyword → trgm or bigm
    - FTS → fts or bm25
- [ ] **Step 2: Run against the example image.**
  Run `cd examples && podman compose up -d db`, then
  `PG_INTEGRATION=1 POSTGRES_PORT=<port> bun test tests/integration/attributeFilters.test.ts`.
  Expected: all PASS. Fix any defects in Tasks 1–5 code here, with a test that pins each one.
- [ ] **Step 3: Run the existing suite** `tests/integration/indexUsage.test.ts`. Expected: still
  9/9.
- [ ] **Step 4: Commit** with message `test(metadata): integration coverage for attribute filters across all legs`.

## Phase 2 — Under-return with selective filters (spec §6.5)

### Task 7: IVFFlat iterative scans

**Files:**
- Modify: `src/adapters/PostgresRagDatabase.ts`
- Test: `tests/postgresRagDatabase.test.ts`

**Interfaces:**
- Produces:
  - `PostgresRagDatabaseOptions.ivfflatIterativeScan?: "off" | "relaxed_order" | "strict_order"`,
    default `"off"`.
  - `PostgresRagDatabaseOptions.ivfflatMaxProbes?: number`, a positive integer, only applied
    when the iterative scan isn't `"off"`. The constructor validates it like `ivfflatProbes`.

**Behavior:**
- When the iterative scan isn't `"off"`, the vector leg adds the GUCs `ivfflat.iterative_scan`
  and (if set) `ivfflat.max_probes` through `runTuned`. It uses this SQL:
  ```sql
  WITH candidates AS MATERIALIZED (
    SELECT id, content, source_type, source_id, metadata, attributes::text AS attributes,
           embedding <=> $2::vector AS distance
    FROM rag_documents WHERE tenant_id = $1 <filters> ORDER BY embedding <=> $2::vector LIMIT $4)
  SELECT id, content, source_type, source_id, metadata, attributes, 1 - distance AS score
  FROM candidates WHERE 1 - distance >= $3 ORDER BY distance + 0 LIMIT $4
  ```
  The `vectorMinScore` floor is outside the CTE.
- When it's `"off"`, the SQL is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - With `ivfflatIterativeScan:"relaxed_order", ivfflatMaxProbes:100`, the captured vector SQL
    contains `AS MATERIALIZED` and `distance + 0`, and the GUC list includes
    `ivfflat.iterative_scan=relaxed_order` and `ivfflat.max_probes=100`.
  - With the default (`"off"`), the SQL equals Task 5's snapshot.
  - `ivfflatMaxProbes: 0` throws in the constructor.
- [ ] **Step 2: Run them and confirm they fail.**
  Run `bun test tests/postgresRagDatabase.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the full quality gate.**
  Run `bun test && bun run typecheck && bun run lint`. Expected: everything passes.
- [ ] **Step 5: Commit** with message `feat(adapter): opt-in pgvector iterative index scans for filtered vector search`.

### Task 8: Under-return integration tests (and the BM25 fix, if needed)

**Files:**
- Create: `tests/integration/filterUnderReturn.test.ts`
- Possibly modify: `src/adapters/fts/Bm25Fts.ts` (conditional; see Step 3)

**Test data:**
- 20,000 rows in one tenant (the deployment ceiling, spec §9.2).
- 2% (400 rows) tagged `segment = rare`.
- Random vectors (fine here: this counts rows returned, it doesn't measure recall), and shared
  lexical content so the keyword and FTS legs match every row.
- `candidateLimit = 40`.

- [ ] **Step 1: Write the tests.** Each one asserts that a leg returns exactly
  `min(candidateLimit, 400) = 40` rows under `segment equals rare`, run on the adapter's
  `hybridSearch`:
  - ivfflat with `relaxed_order` + `ivfflatMaxProbes: 100`: vector rows = 40
  - vchordrq (migration 010): vector rows = 40
  - trgm keyword leg: 40
  - tsvector FTS: 40
  - BM25 FTS: 40
  - ivfflat with `"off"`: log the count without asserting it. It documents the problem and
    could be flaky.
- [ ] **Step 2: Run them.**
  Run `PG_INTEGRATION=1 POSTGRES_PORT=<port> bun test tests/integration/filterUnderReturn.test.ts`.
  Expected: PASS, except possibly BM25.
- [ ] **Step 3: Only if the BM25 case fails** (it returns < 40):
  - Add `Bm25FtsOptions.filterOverfetch?: number`, default 10.
  - When an attribute filter is present, run the BM25 top-K in a materialized CTE with
    `LIMIT candidateLimit * filterOverfetch`, then apply the filter clause and the
    zero-score drop outside it, with `LIMIT candidateLimit`.
  - Add a unit test for the SQL shape. Re-run until the BM25 case returns 40.
  - If BM25 passes in Step 2, skip this step, and record in the commit message that BM25
    pushes the predicate into its scan.
- [ ] **Step 4: Commit** with message `test(metadata): selective-filter under-return coverage per leg` (add `+ BM25 overfetch` if Step 3 ran).

## Phase 3 — Catalog and registry (spec §6.6)

### Task 9: Registry table and `CachingMetadataCatalog`

**Files:**
- Create: `sql/018_metadata_registry.sql`, `sql/019_metadata_registry_rls.sql`,
  `src/adapters/CachingMetadataCatalog.ts`
- Modify: `src/types.ts` (catalog types), `src/interfaces.ts`
  (`MetadataCatalogProvider`), `src/index.ts`
- Test: `tests/cachingMetadataCatalog.test.ts`, `tests/migrate.test.ts`, plus a case in
  `tests/integration/attributeFilters.test.ts`

**Interfaces:**
- Produces, in `src/types.ts`:
  ```ts
  export interface RegisteredKeyInput { ns?: string; key: string; description: string;
    type?: AttributeType; format?: AttributeFormat; multi?: boolean; allowedValues?: string[]; }
  export interface CatalogKey { ns: string; key: string; registered: boolean; description?: string;
    declaredType?: AttributeType; declaredFormat?: AttributeFormat; multi?: boolean; allowedValues?: string[];
    observed: Array<{ type: AttributeType; format?: AttributeFormat; articleCount: number }>;
    topValues?: Array<{ value: string; articleCount: number }>; }
  export interface MetadataCatalog { tenantId: string; generatedAt: string; keys: CatalogKey[]; }
  ```
- Produces, in `src/interfaces.ts`:
  `interface MetadataCatalogProvider { describe(tenantId: string): Promise<MetadataCatalog>; invalidate(tenantId: string): void; }`
- Produces `class CachingMetadataCatalog implements MetadataCatalogProvider`:
  - Config: `{ txProvider: TransactionProvider; ttlMs?: number /* 300_000 */; topValuesPerKey?: number /* 20 */ }`
  - Methods:
    - `describe`
    - `invalidate`
    - `register(tenantId: string, keys: RegisteredKeyInput[]): Promise<void>`: an upsert that
      invalidates the cache.
    - `unregister(tenantId: string, keys: Array<{ ns?: string; key: string }>): Promise<void>`

**Migration 018:**
- `rag_metadata_registry`:
  - columns: `tenant_id UUID NOT NULL`, `ns TEXT NOT NULL`, `key TEXT NOT NULL`,
    `description TEXT NOT NULL`, `type TEXT`, `format TEXT`, `multi BOOLEAN`,
    `allowed_values JSONB`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  - `PRIMARY KEY (tenant_id, ns, key)`

**Migration 019:** an RLS policy on the 007 pattern
(`current_setting('app.current_tenant_id', true)::uuid`).

**Observed queries:**
- Each scoped by `tenant_id = $1`, over `jsonb_array_elements(attributes) e`.
- Article counts use `count(DISTINCT (source_type, source_id))`.
- One query groups by `ns`, `k`, `t`, `f`.
- A second query does the same for the top string values: it groups by `ns`, `k`, `v`
  where `t = 'string'`, ranks with `row_number() OVER (PARTITION BY ns, k ORDER BY count DESC, v) <= $2`.

**Merge:**
- Join on `ns` + `key`.
- Keys are sorted with registered keys first, then by `ns`, then by `key`.
- A registered key with no observed rows has `observed: []`.

**Caching and validation:**
- Per-tenant cache with TTL and in-flight dedup, as in `CachingSynonymLoader`.
- `register` validates its input with the same `ns` / `key` / type / format rules as Task 1.

- [ ] **Step 1: Write the failing tests:**
  - Unit, with a mocked client:
    - The merge order and fields for a fixture of observed rows plus registry rows.
    - Two `describe` calls within the TTL make one query round; after `invalidate` there are
      two.
    - `register` issues `INSERT … ON CONFLICT (tenant_id, ns, key) DO UPDATE` with bound
      parameters, then invalidates.
  - `migrate.test.ts`: 018 is applied by default; 019 only with `{ rls: true }`.
  - Integration: `describe` on the Task 6 corpus reports `region` with
    `observed[0].articleCount` equal to the number of tagged articles (not chunks), and
    `topValues` containing EU.
- [ ] **Step 2: Run them and confirm they fail.**
  Run `bun test tests/cachingMetadataCatalog.test.ts tests/migrate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the migrations, the types and the catalog.** Export them.
- [ ] **Step 4: Run the full quality gate and the integration test.**
  Run `bun test && bun run typecheck && bun run lint`, plus the integration case. Expected:
  PASS.
- [ ] **Step 5: Commit** with message `feat(metadata): tenant catalog (observed + registered keys) with TTL cache`.

### Task 10: Catalog-aware validation and the briefing renderer

**Files:**
- Modify: `src/metadata/filterSchema.ts`
- Create: `src/metadata/briefing.ts`
- Test: `tests/filterSchema.test.ts`, `tests/briefing.test.ts`

**Interfaces:**
- Consumes (from Task 9): `MetadataCatalog`, `CatalogKey`.
- Produces:
  - `FilterValidationOptions` gains `catalog?: MetadataCatalog`, `rejectUnknownKeys?: boolean`
    and `enforceAllowedValues?: boolean`. Both flags default to `false`; the pipeline turns
    them on for model filters (Task 12).
  - `renderCatalogBriefing(catalog: MetadataCatalog, opts?: { maxKeys?: number /* 100 */; maxValuesPerKey?: number /* 20 */ }): string`

**Rules:**
- **Unknown key**: a `(ns, key)` pair absent from `catalog.keys`.
  - No `ns`: the key exists in no namespace.
  - An `ns` list: the key exists in none of the listed namespaces.
- **Allowed values**: applies to `equals` on a registered key with `allowedValues`. Each value
  must equal an allowed value, compared case-insensitively unless `caseSensitive` is set.
- **Briefing format:** one line per key, in catalog order, truncated to `maxKeys`:
  `- ns=<ns> key=<key> type=<type>[(<format>[, multi])] — <description or "(no description)">[; values: v1, v2, …]`.
  - The values are `allowedValues` when present, otherwise `topValues`, truncated to
    `maxValuesPerKey`.
  - A key observed under several types lists them joined with `|`.

- [ ] **Step 1: Write the failing tests:**
  - `rejectUnknownKeys` + a filter on `fare_class` that isn't in the catalog → `ok: false`,
    with an error naming `fare_class`.
  - `enforceAllowedValues` + `region equals "Europe"` against allowed values `["EU","UK"]` →
    `ok: false`.
  - `region equals "eu"` → `ok: true`. With `caseSensitive: true`, "eu" → `ok: false`.
  - Neither flag → both of those filters are `ok: true`.
  - `renderCatalogBriefing` on a two-key fixture equals this exact string:
    `"- ns=knowmax key=region type=string(enum, multi) — Customer home region; values: EU, UK\n- ns=global key=priority type=number — (no description)"`
  - `maxKeys: 1` → only the first line.
- [ ] **Step 2: Run them and confirm they fail.**
  Run `bun test tests/filterSchema.test.ts tests/briefing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Export `renderCatalogBriefing`.
- [ ] **Step 4: Run them and confirm they pass.**
  Run `bun test tests/filterSchema.test.ts tests/briefing.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(metadata): catalog-aware filter validation + model briefing renderer`.

## Phase 4 — Pluggable filter model (spec §6.7, §9.3)

### Task 11: `FilterModelProvider` and `OpenAiCompatibleFilterModel`

**Files:**
- Modify: `src/interfaces.ts`, `src/index.ts`
- Create: `src/adapters/OpenAiCompatibleFilterModel.ts`
- Test: `tests/openAiCompatibleFilterModel.test.ts`

**Interfaces:**
- Consumes: `FILTER_GENERATION_SCHEMA` (Task 3), `renderCatalogBriefing` (Task 10),
  `MetadataCatalog`.
- Produces:
  - `interface FilterModelContext { tenantId: string; language: string }`
  - `interface FilterModelProvider { generateFilter(query: string, catalog: MetadataCatalog, ctx: FilterModelContext): Promise<unknown> }`
    The pipeline validates the result, so the return type is `unknown` on purpose.
  - `OpenAiCompatibleFilterModel` config:
    `{ baseUrl: string; model: string; apiKey?: string; timeoutMs?: number /* 10_000 */; maxRetries?: number /* 1 */; retryBaseDelayMs?: number /* 250 */; briefing?: { maxKeys?: number; maxValuesPerKey?: number }; systemPrompt?: string }`

**Behavior:**
- It sends `POST ${baseUrl}/chat/completions` (the same URL convention as
  `OpenAiCompatibleEmbedder`) with:
  - `temperature: 0`
  - `response_format: { type: "json_schema", json_schema: { name: "rag_filter", strict: true, schema: FILTER_GENERATION_SCHEMA } }`
  - a system message: the default prompt (or `systemPrompt`) plus the rendered catalog briefing
  - a user message containing the query
- It returns `JSON.parse(choices[0].message.content).filter`, or throws
  `FilterModelResponseError` on the wrong shape.
- Timeouts, retries and backoff copy `OpenAiCompatibleEmbedder`: retry on 429, 5xx, network
  errors and timeouts.
- The default prompt states:
  - Output only keys from the briefing.
  - Use `ns` only when the query implies a source.
  - Use `type` for dates, datetimes and decimals.
  - Return `{"filter": null}` when the query implies no filter.

- [ ] **Step 1: Write the failing tests** with a mocked `fetch`:
  - The request body has the `json_schema` `response_format` with `strict: true`, the schema
    deep-equal to `FILTER_GENERATION_SCHEMA`, and a system message containing the briefing
    line for `region`.
  - The content `{"filter":{"key":"region","op":"equals","value":"EU","ns":null,"type":null,"caseSensitive":null}}`
    returns that filter object.
  - The content `{"filter":null}` returns `null`.
  - The content `"not json"` throws `FilterModelResponseError` with no retry (one fetch call).
  - A 503 then a 200 → two fetch calls and a result.
  - A timeout → `AbortError`, retried according to `maxRetries`.
- [ ] **Step 2: Run them and confirm they fail.**
  Run `bun test tests/openAiCompatibleFilterModel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Export the interface types, the adapter and its config type,
  and `FilterModelResponseError`.
- [ ] **Step 4: Run them and confirm they pass.**
  Run `bun test tests/openAiCompatibleFilterModel.test.ts && bun run typecheck && bun run lint`.
  Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(metadata): pluggable filter model + OpenAI-compatible adapter`.

### Task 12: Pipeline auto-filter, retry and diagnostics

**Files:**
- Modify: `src/RagPipeline.ts`, `src/types.ts`, `src/index.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `FilterModelProvider` (Task 11), `MetadataCatalogProvider` (Task 9),
  `validateFilter` / `assertValidFilter` with the catalog options (Tasks 3 and 10).
- Produces:
  - `RagPipelineConfig.filterModel?: FilterModelProvider` and
    `RagPipelineConfig.metadataCatalog?: MetadataCatalogProvider`
  - `RagSearchOptions.autoFilter?: boolean` (default `false`) and
    `RagSearchOptions.autoFilterRetryOnEmpty?: boolean` (default `true`)
  - ```ts
    export interface SearchDiagnostics {
      explicitFilter: FilterExpression | null;
      generatedFilter: unknown | null;                 // raw model output
      generatedFilterStatus: "not_requested" | "none" | "applied" | "invalid" | "error";
      generatedFilterErrors?: string[];
      retriedWithoutGeneratedFilter: boolean;
    }
    ```
  - `RagPipeline.searchWithDiagnostics(query: string, options?: RagSearchOptions): Promise<{ results: RagResult[]; diagnostics: SearchDiagnostics }>`
  - The existing `search()` delegates to it and returns `.results`; its return type is
    unchanged.

**Behavior:**
- If `autoFilter` is set without `filterModel` or `metadataCatalog`, throw an `Error`
  (misconfiguration).
- `catalog.describe` + `generateFilter` run concurrently with `embedQuery`.
- The generated filter is validated with
  `{ catalog, rejectUnknownKeys: true, enforceAllowedValues: true }`.
  - Invalid → status `"invalid"`, `logger.warn`, and the filter is dropped.
  - A thrown error or rejection → status `"error"`, `logger.warn`, and the filter is dropped.
  - `null` → status `"none"`.
- The effective filter is `{ and: [explicit, generated] }` when both exist, otherwise whichever
  exists.
- Fail-closed (Task 5) applies to the effective filter.
- **Retry:** when status is `"applied"`, all three legs return zero rows, and
  `autoFilterRetryOnEmpty !== false`, run `hybridSearch` once more with only the explicit filter.
  Set `retriedWithoutGeneratedFilter: true`.
- **Tracing:** span attributes `generatedFilterStatus` and `retriedWithoutGeneratedFilter`.

- [ ] **Step 1: Write the failing tests** with mocked embedder, db, model and catalog:
  - A valid generated filter plus an explicit filter: `hybridSearch` receives `attributeFilter`
    equal to the validated `and` of both, and the status is `"applied"`.
  - A generated filter with an out-of-list value ("Europe") → status `"invalid"`; `hybridSearch`
    receives only the explicit filter; one warn log.
  - The model rejects → status `"error"`, and the search still returns results.
  - An applied filter with all legs empty → a second `hybridSearch` call without the generated
    part; `retriedWithoutGeneratedFilter: true`.
    - With `autoFilterRetryOnEmpty: false`, there's a single call and empty results.
    - The explicit filter is present in both calls.
  - `autoFilter` without a `filterModel` throws.
  - **Concurrency:** both `generateFilter` and `embedQuery` start before either resolves
    (assert with deferred promises).
  - `search()` returns the same results as `searchWithDiagnostics().results`.
- [ ] **Step 2: Run them and confirm they fail.**
  Run `bun test tests/pipeline.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Export `SearchDiagnostics`.
- [ ] **Step 4: Run the full quality gate.**
  Run `bun test && bun run typecheck && bun run lint`. Expected: everything passes.
- [ ] **Step 5: Commit** with message `feat(metadata): auto-filter in the pipeline with validation, retry-on-empty and diagnostics`.

### Task 13: Docs, version and no-filter regression

**Files:**
- Modify: `README.md` (a new "Metadata filters" section), `CLAUDE.md` (Architecture / Key
  files / Design patterns), `package.json` (0.6.0)
- Create: `CHANGELOG.md` if it's absent; otherwise add an entry.

- [ ] **Step 1: Document the feature in `README.md`:**
  - Attribute types and formats, with the caller's normalization duties: dates, E.164 phones,
    decimal strings.
  - `index(..., { attributes })`.
  - The filter grammar, with the spec §6.2 example and the type-resolution rule.
  - The legacy `[]` semantics.
  - The catalog: `register`, `describe`.
  - `autoFilter` with `OpenAiCompatibleFilterModel`, `searchWithDiagnostics`, and the retry
    default.
  - Fail-closed and `supportsAttributeFilters` for custom implementations.
  - Migrations 017–019.
  - The `ivfflatIterativeScan` recommendation for single-tenant databases.
- [ ] **Step 2: Update `CLAUDE.md`** key-files rows for the `src/metadata/*` files and
  `CachingMetadataCatalog`, plus a design-pattern bullet for attribute filters.
- [ ] **Step 3: Set the version and changelog.** `package.json` version becomes `0.6.0`. The
  `CHANGELOG.md` entry notes:
  - the new optional interface fields (`supportsAttributeFilters`), and that custom
    implementations now fail closed when a filter is passed
  - `RagResult.attributes` is added
  - the new migrations
- [ ] **Step 4: Run the quality gate and build.**
  Run `bun test && bun run typecheck && bun run lint && bun run build`. Expected: everything
  passes.
- [ ] **Step 5: Run the no-filter regression.**
  Run `bun run examples/benchmark/regression.ts`. This needs the GPU infra; see
  `examples/benchmark/BASELINES.md`. Expected: every suite is `OK`, which shows the column and
  the plumbing change nothing without a filter. If the infra is unavailable, say so in the PR
  instead of claiming a pass.
- [ ] **Step 6: Commit** with message `docs(metadata): document attribute filters, catalog and filter model; release 0.6.0`.
