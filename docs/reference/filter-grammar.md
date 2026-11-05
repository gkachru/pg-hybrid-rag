# Filter grammar

This page specifies typed attributes (what you attach at index time), the filter expression grammar (what you pass to `search({ filter })`), how each operator matches, and the validation functions, limits and JSON Schemas that enforce both.

```ts
import {
  assertValidFilter,
  DEFAULT_ATTRIBUTE_LIMITS,
  DEFAULT_FILTER_LIMITS,
  FILTER_GENERATION_SCHEMA,
  FILTER_JSON_SCHEMA,
  GLOBAL_NS,
  normalizeAttributes,
  parseAttributes,
  serializeAttributes,
  validateFilter,
} from "pg-hybrid-rag";
```

## Attributes

An attribute is a typed, namespaced value attached to a whole source (article) at index time through `RagIndexer.index(sourceType, sourceId, chunks, language, { attributes })`. The same attributes are stored on every chunk row of that source in the `rag_documents.attributes` JSONB column and returned on each result as `RagResult.attributes`.

### Attribute input

`AttributeInput` fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ns` | `string` | No | Namespace, 1-128 characters. Defaults to `"global"` (`GLOBAL_NS`). |
| `key` | `string` | Yes | Attribute name, 1-128 characters. |
| `type` | `AttributeType` | Yes | `"string"`, `"number"`, `"boolean"`, `"date"` or `"datetime"`. |
| `format` | `AttributeFormat` | No | Refines `type`. See [Types and formats](#types-and-formats). |
| `multi` | `boolean` | No | Only valid with `format: "enum"`. Marks a multi-valued enum. |
| `value` | `string \| number \| boolean \| string[]` | Yes | The value. Lists are allowed only for plain strings and multi enums. |

Each `(ns, key)` pair may appear at most once per source. To give several values, pass a list.

```ts
import type { AttributeInput } from "pg-hybrid-rag";

const attributes: AttributeInput[] = [
  { key: "region", type: "string", value: ["EU", "UK"] },
  { ns: "cms", key: "status", type: "string", format: "enum", value: "published" },
  { ns: "cms", key: "tags", type: "string", format: "enum", multi: true, value: ["billing", "faq"] },
  { key: "price", type: "number", format: "decimal", value: "19.90" },
  { key: "in_stock", type: "boolean", value: true },
  { key: "effective_date", type: "date", value: "2026-01-15" },
  { key: "updated_at", type: "datetime", value: "2026-03-15T10:00:00+05:30" },
];

await indexer.index("article", "7d0f1c2e-5b7a-4c1e-9a53-1f2e3d4c5b6a", chunks, "en", { attributes });
```

### Types and formats

| `type` | `format` | Accepted `value` | Validation rule | Stored as |
|--------|----------|------------------|-----------------|-----------|
| `string` | omitted or `text` | `string` or non-empty `string[]` | Each string at most `maxStringLength` characters. | Raw value plus a case-folded copy. |
| `string` | `email` | `string` | Matches `^[^\s@]+@[^\s@]+\.[^\s@]+$`. | Same as `text`. |
| `string` | `url` | `string` | Parses with the WHATWG `new URL()` constructor (absolute URL). | Same as `text`. |
| `string` | `phone` | `string` | E.164: `^\+[1-9]\d{6,14}$` (a `+`, then 7-15 digits, first digit not 0). | Same as `text`. |
| `string` | `enum` | `string`; with `multi: true`, a non-empty `string[]` | A single enum must be a scalar; a multi enum must be a list. Allowed values are not checked at index time. | Same as `text`. |
| `number` | omitted or `float` | `number` | Finite JavaScript number. | JSON number. |
| `number` | `decimal` | `string` | Plain decimal literal `^-?(0\|[1-9]\d*)(\.\d+)?$`: no `+`, no exponent, no leading zeros. | Exact numeric literal; the original string is kept for output. |
| `boolean` | (none) | `boolean` | | JSON boolean. |
| `date` | (none) | `string` | `YYYY-MM-DD` and a real calendar date. | The string. |
| `datetime` | (none) | `string` | `YYYY-MM-DDTHH:MM[:SS[.fff]]` followed by `Z` or an offset (`+05:30` or `+0530`). Values without a timezone are rejected. Out-of-range fields (for example `24:00`, `02-30`) are rejected. | Normalized to UTC in `Date.toISOString()` form, for example `2026-03-15T04:30:00.000Z`. |

Other rules:

- `format` must belong to `type`: `string` takes `text`, `email`, `url`, `phone`, `enum`; `number` takes `float`, `decimal`; `boolean`, `date` and `datetime` take none.
- `multi: true` requires `format: "enum"`.
- List values are allowed only for `string` with no format or `text`, and for multi enums. A list must not be empty.
- The string length limit applies to `string` values only.

### Attribute limits

`DEFAULT_ATTRIBUTE_LIMITS` (type `AttributeLimits`). Override per indexer with `RagIndexerConfig.attributeLimits` (a `Partial<AttributeLimits>`); see [RagIndexer](/reference/rag-indexer).

| Limit | Default | Applies to |
|-------|---------|------------|
| `maxAttributes` | `50` | Number of entries in the `attributes` array for one source. |
| `maxValuesPerAttribute` | `20` | Length of a list value. |
| `maxStringLength` | `256` | Characters per `string` value. Matches `DEFAULT_FILTER_LIMITS.maxStringLength`, so every stored string can be matched exactly by a filter. |

The `ns` and `key` length limit (128 characters) is fixed and not configurable.

Attributes are validated before any embedding call. Every problem is collected and thrown together as an [`AttributeValidationError`](/reference/errors#attributevalidationerror) whose `issues` array lists each one, for example `cms.status: single enum needs a scalar value`.

### Attribute output

`RagResult.attributes` is an `AttributeOutput[]`: one entry per `(ns, key, type)` in first-appearance order, with fields `ns`, `key`, `type`, optional `format`, and `value`.

| Stored attribute | `value` in output |
|------------------|-------------------|
| Plain string list or multi enum | `string[]` |
| Any scalar | The scalar |
| `number` with `format: "decimal"` | The original decimal string, for example `"19.90"` |
| `datetime` | The normalized UTC string, not the input string |

Rows indexed before attributes existed (or indexed without attributes) hold `[]` and return `attributes: []`.

### Storage encoding

`normalizeAttributes` turns each input value into one `StoredAttributeEntry`; a list becomes one entry per element. The JSON array of entries is what the `attributes` column stores.

| Field | Meaning |
|-------|---------|
| `ns` | Namespace. |
| `k` | Key. |
| `t` | `AttributeType`. |
| `f` | `AttributeFormat`, when given. |
| `v` | The value. For decimals, the exact numeric literal (serialized as a raw JSON number). |
| `l` | Case-folded copy (`toLowerCase()`), strings only. |
| `s` | Decimals only: the original decimal string, for exact output. |
| `m` | `true` when the entry came from a list value. |

```json
[
  { "ns": "global", "k": "region", "t": "string", "v": "EU", "l": "eu", "m": true },
  { "ns": "global", "k": "region", "t": "string", "v": "UK", "l": "uk", "m": true },
  { "v": 19.90, "ns": "global", "k": "price", "t": "number", "f": "decimal", "s": "19.90" }
]
```

### Attribute functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `normalizeAttributes` | `(input: AttributeInput[], limits?: Partial<AttributeLimits>) => StoredAttributeEntry[]` | Validates and normalizes input into storage entries. Unset limits fall back to `DEFAULT_ATTRIBUTE_LIMITS`. Throws `AttributeValidationError` listing every issue. |
| `serializeAttributes` | `(entries: StoredAttributeEntry[]) => string` | Serializes entries to the JSON text stored in the column. Decimal `v` values are written as raw numeric literals to keep full precision. Throws `Error` if a decimal entry's `v` is not a decimal string. |
| `parseAttributes` | `(json: string) => AttributeOutput[]` | Parses stored JSON back into outputs, regrouping entries by `ns` + `key` + `type`. Throws if `json` is not valid JSON. |
| `GLOBAL_NS` | `"global"` | The namespace used when `ns` is omitted. |

```ts
import { normalizeAttributes, parseAttributes, serializeAttributes } from "pg-hybrid-rag";

const json = serializeAttributes(
  normalizeAttributes([{ key: "price", type: "number", format: "decimal", value: "19.90" }]),
);
const [price] = parseAttributes(json); // { ns: "global", key: "price", type: "number", format: "decimal", value: "19.90" }
```

## Filter expressions

A filter is a `FilterExpression`: either a condition, or a boolean node.

```text
FilterExpression := FilterCondition
                  | { "and": FilterExpression[] }    (non-empty)
                  | { "or":  FilterExpression[] }    (non-empty)
                  | { "not": FilterExpression }
```

A boolean node must contain exactly one of `and`, `or`, `not` and no other property.

### Conditions

`FilterCondition` fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | `string` | Yes | Attribute key. Non-empty, at most `maxStringLength` characters. |
| `op` | `FilterOp` | Yes | One of the [operators](#operators). |
| `value` | `FilterScalar \| FilterScalar[]` | Yes | Operand. A list is allowed only for `equals` and `between`. `FilterScalar` is `string \| number \| boolean`; numbers must be finite. |
| `ns` | `string \| string[] \| null` | No | Namespace scope. See [Namespaces](#namespaces). |
| `type` | `AttributeType \| null` | No | Attribute type to match. When omitted or `null`, it is inferred. See [Type resolution](#type-resolution). |
| `caseSensitive` | `boolean \| null` | No | Strings only. Default `false`. See [Case folding](#case-folding). |

Any other property is a validation error.

```ts
import type { FilterExpression } from "pg-hybrid-rag";

const filter: FilterExpression = {
  and: [
    { key: "region", op: "equals", value: ["EU", "UK"] },
    { ns: "cms", key: "effective_date", op: "gte", value: "2026-01-01" },
    { not: { ns: ["cms", "wiki"], key: "audience", op: "equals", value: "internal" } },
    {
      or: [
        { ns: "wiki", key: "team", op: "startsWith", value: "pay" },
        { key: "priority", op: "exists", value: true },
      ],
    },
  ],
};

const results = await pipeline.search(query, { language: "en", filter });
```

### Operators

| `op` | Types | `value` | Matches when |
|------|-------|---------|--------------|
| `equals` | `string`, `number`, `boolean`, `date`, `datetime` | Scalar, or a list of 1 to `maxListSize` scalars | A stored value of the same type equals the operand. A list means any of the values (OR). |
| `startsWith` | `string` | Scalar string | A stored string starts with the operand. |
| `endsWith` | `string` | Scalar string | A stored string ends with the operand. |
| `contains` | `string` | Scalar string | A stored string contains the operand as a substring. |
| `gt`, `gte`, `lt`, `lte` | `number`, `date`, `datetime` | Scalar | A stored value compares `>`, `>=`, `<`, `<=` to the operand. |
| `between` | `number`, `date`, `datetime` | List of exactly 2 values `[lo, hi]`, with `lo <= hi` | A stored value is `>= lo` and `<= hi` (inclusive on both ends). |
| `exists` | Any | `true` or `false` | `true`: the source has an attribute with this key (in the scoped namespaces), of any type. `false`: it has none. |

Operator details:

- `startsWith`, `endsWith` and `contains` are plain substring tests (`starts_with`, `right`, `strpos`). `%`, `_` and other pattern characters have no special meaning.
- For multi-valued attributes (string lists and multi enums), a condition matches when any one stored value matches.
- `number` comparisons are numeric (Postgres `numeric`), so float and decimal attributes compare by value, and `"99.990"` equals a stored `99.99`.
- `date` values compare as `YYYY-MM-DD` text, which orders chronologically.
- `datetime` operands are normalized to UTC before comparison, so offsets are compared correctly against stored UTC values.
- For `exists`, `type` is accepted but not used, and `caseSensitive` has no effect.
- `boolean` supports only `equals` and `exists`.

### Namespaces

| `ns` in the condition | Scope |
|-----------------------|-------|
| Omitted or `null` | Any namespace, including `"global"`. |
| `"cms"` | Only attributes in `cms`. |
| `["cms", "wiki"]` | Attributes in any listed namespace. The list must be non-empty and hold at most `maxListSize` non-empty strings. |

Attributes indexed without `ns` live in `"global"`. To match only those, set `ns: "global"`.

### Type resolution

Matching is type-strict: a condition matches only stored entries whose `type` equals the condition's resolved type. A `number` condition never matches a `string` attribute holding `"10"`.

The type is resolved as follows:

1. If `type` is set, it is used. The values must be valid for that type.
2. Otherwise, if all values are numbers, the type is `number`.
3. Otherwise, if all values are booleans, the type is `boolean`.
4. Otherwise, if all values are strings:
   - for `equals`, `startsWith`, `endsWith`, `contains`: `string`;
   - for `gt`, `gte`, `lt`, `lte`, `between`: `date` if every value is a valid `YYYY-MM-DD` date, else `datetime` if every value is a datetime with a timezone, else a validation error (`cannot infer the type of these string values; set "type"`).
5. Mixed value types are a validation error.
6. For `exists`, no inference happens; the resolved type is `type` or `"string"`, and it does not affect matching.

Consequences:

- `{ key: "effective_date", op: "equals", value: "2026-01-15" }` resolves to `string` and does not match a `date` attribute. Set `type: "date"`.
- A decimal string such as `"10.5"` resolves to `string` (or fails for range operators). Set `type: "number"` to compare it as a number. With `type: "number"`, a value may be a finite number or a plain decimal string; decimal strings keep full precision.

After resolution, the operator must be allowed for the type (see [Operators](#operators)), otherwise validation fails with `op "<op>" is not allowed for type "<type>"`.

### Case folding

String conditions are case-insensitive by default: the operand is folded with JavaScript `toLowerCase()` and compared against the folded copy (`l`) stored with each string value. With `caseSensitive: true`, the operand is compared unchanged against the raw stored value (`v`).

Folding is `toLowerCase()` only. It does not remove accents or apply full Unicode case folding (for example, `ß` does not match `ss`).

### Rows without attributes

Rows with no attributes (`[]`), including rows indexed before migration 017, match no positive condition. They match `not { ... }` and `exists: false`.

## Validation

`RagPipeline.search` validates an explicit `filter` with `assertValidFilter` and `DEFAULT_FILTER_LIMITS` before any embedding or database work, and throws [`FilterValidationError`](/reference/errors#filtervalidationerror) on failure. It has no option to change the filter limits. A filter generated by `autoFilter` is validated with `validateFilter` using the tenant catalog, `rejectUnknownKeys: true` and `enforceAllowedValues: true`; an invalid generated filter is dropped rather than thrown (see [RagPipeline](/reference/rag-pipeline)).

### Limits

`DEFAULT_FILTER_LIMITS` (type `FilterLimits`):

| Limit | Default | Applies to |
|-------|---------|------------|
| `maxDepth` | `5` | Nesting of boolean nodes (`and`/`or`/`not`). The root node counts as level 1; up to 5 nested boolean nodes are allowed, with conditions below them. |
| `maxConditions` | `32` | Total number of conditions in the whole expression. |
| `maxListSize` | `50` | Length of an `equals` value list and of an `ns` list. |
| `maxStringLength` | `256` | Characters in `key`, in each `ns` entry, and in each string value. |

### validateFilter

<!-- no-check -->
```ts
function validateFilter(
  expr: unknown,
  options?: FilterValidationOptions,
): { ok: true; filter: ValidatedFilter } | { ok: false; errors: string[] };
```

Validates and normalizes a filter expression. It never throws for invalid input. On success, `filter` is a `ValidatedFilter`: the same tree shape, with each condition replaced by a `ResolvedCondition`. On failure, `errors` lists the problems found, each prefixed with a JSONPath-like location (`$`, `$.and[0]`, `$.not`), except the `more than <maxConditions> conditions` error, which has no location. Within one condition, checks after the first failing value check are skipped.

```ts
import { validateFilter } from "pg-hybrid-rag";

const r = validateFilter({ key: "price", op: "between", value: [10] });
if (!r.ok) console.log(r.errors); // ["$: between takes exactly 2 values"]
```

### assertValidFilter

<!-- no-check -->
```ts
function assertValidFilter(expr: unknown, options?: FilterValidationOptions): ValidatedFilter;
```

Same as `validateFilter`, but throws `FilterValidationError` (with an `errors: string[]` field) instead of returning `{ ok: false }`.

### FilterValidationOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limits` | `Partial<FilterLimits>` | `DEFAULT_FILTER_LIMITS` | Overrides individual limits. |
| `catalog` | `MetadataCatalog` | none | Tenant catalog used by the two checks below. Without it, both checks are skipped. |
| `rejectUnknownKeys` | `boolean` | `false` | Reject a condition whose `key` has no catalog entry in the scoped namespaces (any namespace when `ns` is unset). Error: `unknown metadata key "<key>"`. |
| `enforceAllowedValues` | `boolean` | `false` | For `equals` conditions of type `string`: when any matching catalog key has a non-empty `allowedValues`, every operand must equal one of them (compared after folding unless `caseSensitive`). Error: `value "<v>" is not an allowed value for "<key>"`. |

```ts
import { CachingMetadataCatalog, validateFilter } from "pg-hybrid-rag";

const catalog = await new CachingMetadataCatalog({ txProvider }).describe(tenantId);
const r = validateFilter(
  { ns: "cms", key: "status", op: "equals", value: "archived" },
  { catalog, rejectUnknownKeys: true, enforceAllowedValues: true },
);
```

### ResolvedCondition

The normalized form of a condition inside a `ValidatedFilter`.

| Field | Type | Description |
|-------|------|-------------|
| `ns` | `string[] \| null` | Namespaces; `null` means any. |
| `key` | `string` | Attribute key. |
| `op` | `FilterOp` | Operator. |
| `type` | `AttributeType` | Resolved type. |
| `values` | `FilterScalar[]` | Normalized operands: strings folded unless `caseSensitive`, datetimes in UTC ISO form, decimal strings kept as strings. `exists` holds `[true]` or `[false]`. |
| `caseSensitive` | `boolean` | `true` only when the condition set `caseSensitive: true`. |

`ValidatedFilter` is `ResolvedCondition | { and: ValidatedFilter[] } | { or: ValidatedFilter[] } | { not: ValidatedFilter }`. It is the type of `HybridSearchParams.attributeFilter` and `FtsContext.attributeFilter`.

## JSON Schemas

Both schemas describe the same wrapper object, `{ "filter": FilterExpression | null }`, not a bare expression. `filter: null` means "no filter". Recursive parts are defined under `$defs` (`expr`, `condition`, `and`, `or`, `not`), and `additionalProperties` is `false` throughout.

| Constant | Intended use | Differences |
|----------|--------------|-------------|
| `FILTER_JSON_SCHEMA` | Validating or documenting filters with a general JSON Schema tool. | Declares `$schema: "https://json-schema.org/draft/2020-12/schema"`. A condition requires only `key`, `op`, `value`. |
| `FILTER_GENERATION_SCHEMA` | Structured output from an LLM that requires strict schemas (every property required). Used by `OpenAiCompatibleFilterModel`. | No `$schema`. A condition requires all six properties; `ns`, `type` and `caseSensitive` accept `null` for "not set". |

The schemas check structure only. Semantic rules (operator/type compatibility, list lengths, `between` order, limits, catalog checks) are enforced by `validateFilter`, so always validate model output with it.

## Related

- [Filter by metadata](/how-to/filter-by-metadata)
- [Derive filters from the query](/how-to/auto-filter)
- [Metadata model](/explanation/metadata-model)
- [Types](/reference/types)
