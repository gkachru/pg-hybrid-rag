# Metadata catalog and filter model

`CachingMetadataCatalog` describes which metadata keys a tenant can filter on, by merging the attributes found in indexed rows with keys you register. `OpenAiCompatibleFilterModel` sends a query and that catalog to an OpenAI-compatible chat completions API and returns a generated filter. `RagPipeline` uses both when a search sets `autoFilter: true`. This page covers their configuration, methods, caching, request format, retries and errors.

```ts
import {
  CachingMetadataCatalog,
  OpenAiCompatibleFilterModel,
  PostgresRagDatabase,
  RagPipeline,
} from "pg-hybrid-rag";

const metadataCatalog = new CachingMetadataCatalog({ txProvider });
const filterModel = new OpenAiCompatibleFilterModel({
  baseUrl: "https://api.example.com/v1",
  apiKey: "your-api-key",
  model: "your-model",
});

const pipeline = new RagPipeline({
  tenantId,
  db: new PostgresRagDatabase(txProvider),
  embedder,
  metadataCatalog,
  filterModel,
});

const results = await pipeline.search("billing articles from 2025", {
  language: "en",
  autoFilter: true,
});
```

## CachingMetadataCatalog

Implements [`MetadataCatalogProvider`](/reference/interfaces).

<!-- no-check -->
```ts
new CachingMetadataCatalog(config: CachingMetadataCatalogConfig)
```

### CachingMetadataCatalogConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `txProvider` | `TransactionProvider` | required | Supplies the connection for loads, `register()` and `unregister()`. |
| `ttlMs` | `number` | `300000` (5 minutes) | Age after which a cached catalog is stale. |
| `topValuesPerKey` | `number` | `20` | Maximum most-common string values reported per key. |

The constructor does not validate its input.

### describe()

<!-- no-check -->
```ts
describe(tenantId: string): Promise<MetadataCatalog>
```

Returns the tenant's catalog: `{ tenantId, generatedAt, keys: CatalogKey[] }`, where `generatedAt` is an ISO 8601 timestamp of the load. See [Types](/reference/types) for `MetadataCatalog` and `CatalogKey`.

Caching (stale-while-revalidate):

| Cache state | Behavior |
|---|---|
| No entry for the tenant | Waits for a load. Concurrent callers share it. A failed load rejects and nothing is cached. |
| Entry younger than `ttlMs` | Returns the cached catalog. |
| Entry `ttlMs` or older | Returns the stale catalog immediately and starts one background load, shared by concurrent callers. A failed background load is ignored (no log, no unhandled rejection); the stale entry is kept and a later call tries again. |

`invalidate()`, `register()` and `unregister()` drop the entry, so the next `describe()` waits for a fresh load. A load that started before the drop does not write its result to the cache.

A load runs three queries in order on one connection:

1. **Observed keys:** one row per `(ns, key, type, format)` found in `rag_documents.attributes` for the tenant, with the number of distinct articles (`source_type, source_id` pairs). Rows with `attributes = '[]'` are skipped.
2. **Top values:** for string-typed entries only, the `topValuesPerKey` most common values per `(ns, key)`, by distinct article count descending, then value.
3. **Registry:** the tenant's rows in `rag_metadata_registry`.

The results are merged into one `CatalogKey` per `(ns, key)`:

| `CatalogKey` field | Source |
|---|---|
| `ns`, `key` | Registry or observed data |
| `registered` | `true` when a registry row exists |
| `description`, `declaredType`, `declaredFormat`, `multi`, `allowedValues` | Registry row, when set |
| `observed` | `{ type, format?, articleCount }` per observed type and format, sorted by `articleCount` descending, then type, then format |
| `topValues` | `{ value, articleCount }` from query 2, when any |

Keys are sorted with registered keys first, then by `ns`, then by `key` (code-unit order).

### register()

<!-- no-check -->
```ts
register(tenantId: string, keys: RegisteredKeyInput[]): Promise<void>
```

Validates `keys`, upserts them into `rag_metadata_registry` in one statement (`INSERT ... ON CONFLICT (tenant_id, ns, key) DO UPDATE`, replacing `description`, `type`, `format`, `multi`, `allowed_values` and `updated_at`), then calls `invalidate(tenantId)`. An empty array does nothing. The keys are bound as one JSON parameter, and `tenantId` is cast to `uuid`.

| `RegisteredKeyInput` field | Type | Default | Description |
|---|---|---|---|
| `ns` | `string` | `"global"` | Namespace, 1 to 128 characters. |
| `key` | `string` | required | Key name, 1 to 128 characters. |
| `description` | `string` | required | Shown to the filter model. Must not be blank. |
| `type` | `AttributeType` | none | Declared type. |
| `format` | `AttributeFormat` | none | Declared format. Requires `type` and must be valid for it. |
| `multi` | `boolean` | none | Only valid with `format: "enum"`. |
| `allowedValues` | `string[]` | none | Values the filter model may use. Only for string keys or keys without a declared type. Must be a non-empty list of unique strings. |

Validation runs before any query. If any key fails, `register()` throws an `Error` whose message starts with `Invalid registry keys: ` and lists every problem, including a repeated `(ns, key)` within the call. Types and formats are listed on [Filter grammar](/reference/filter-grammar).

```ts
import { CachingMetadataCatalog } from "pg-hybrid-rag";

const catalog = new CachingMetadataCatalog({ txProvider });

await catalog.register(tenantId, [
  {
    ns: "cms",
    key: "category",
    description: "Help center section",
    type: "string",
    format: "enum",
    allowedValues: ["billing", "account", "shipping"],
  },
  { ns: "cms", key: "published", description: "Publication date", type: "date" },
]);
```

### unregister()

<!-- no-check -->
```ts
unregister(tenantId: string, keys: Array<{ ns?: string; key: string }>): Promise<void>
```

Deletes the matching registry rows (`ns` defaults to `"global"`), then calls `invalidate(tenantId)`. An empty array does nothing. Keys that still occur in indexed attributes stay in the catalog with `registered: false`.

### invalidate()

<!-- no-check -->
```ts
invalidate(tenantId: string): void
```

Drops the tenant's cached catalog and in-flight load. Call it after bulk re-indexing if the next search must see new attribute keys or values before `ttlMs` passes.

## OpenAiCompatibleFilterModel

Implements [`FilterModelProvider`](/reference/interfaces) against an OpenAI-compatible chat completions API that supports `response_format` with `type: "json_schema"` and `strict: true`. Uses the global `fetch`.

<!-- no-check -->
```ts
new OpenAiCompatibleFilterModel(config: OpenAiCompatibleFilterModelConfig)
```

### OpenAiCompatibleFilterModelConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | required | Requests go to `${baseUrl}/chat/completions` (string concatenation), so this usually ends in `/v1`. |
| `model` | `string` | required | Sent as `model`. |
| `apiKey` | `string` | none | When set, sent as `Authorization: Bearer <apiKey>`. When unset or empty, no `Authorization` header is sent. |
| `timeoutMs` | `number` | `10000` | Per-request timeout. `0` disables it. |
| `maxRetries` | `number` | `1` | Retries after the first attempt, for retryable failures only. |
| `retryBaseDelayMs` | `number` | `250` | Base delay for exponential backoff. The wait before retry `n` (1-based) is `retryBaseDelayMs * 2^(n-1)`. |
| `maxTokens` | `number` | none | Sent as `max_tokens` when set. Omitted from the request when unset. |
| `briefing` | `{ maxKeys?: number; maxValuesPerKey?: number }` | `{ maxKeys: 100, maxValuesPerKey: 20 }` | Limits on how much of the catalog goes into the prompt. |
| `systemPrompt` | `string` | built-in prompt | Replaces the default instructions. The catalog briefing is still appended. |

`RagPipeline`'s `filterTimeoutMs` (default 3000 ms) bounds the whole filter step, including retries, and aborts the request through `ctx.signal` when it expires.

#### Constructor errors

| Condition | Error |
|---|---|
| `maxTokens` is set and is not a positive integer | `Error`: `OpenAiCompatibleFilterModel: maxTokens must be a positive integer` |

### generateFilter()

<!-- no-check -->
```ts
generateFilter(query: string, catalog: MetadataCatalog, ctx: FilterModelContext): Promise<unknown>
```

Returns the `filter` value from the model's answer, which is a filter expression or `null`. The result is not validated here; `RagPipeline` validates it against the catalog. `ctx.signal`, when given, cancels the in-flight request.

### Request

```text
POST {baseUrl}/chat/completions
Content-Type: application/json
Authorization: Bearer {apiKey}      (only when apiKey is set)
```

```json
{
  "model": "your-model",
  "temperature": 0,
  "max_tokens": 512,
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "rag_filter", "strict": true, "schema": "<FILTER_GENERATION_SCHEMA>" }
  },
  "messages": [
    { "role": "system", "content": "<system prompt>\n\nAvailable keys:\n<briefing>" },
    { "role": "user", "content": "billing articles from 2025" }
  ]
}
```

`max_tokens` appears only when `maxTokens` is set. `schema` is the `FILTER_GENERATION_SCHEMA` object (see [Filter grammar](/reference/filter-grammar)). The user message is the query string exactly as passed to `RagPipeline.search()`.

The default system prompt is:

```text
You convert a user's search query into a metadata filter.
Output only keys that appear in the briefing below; never invent keys or values.
Set `ns` only when the query implies a source; otherwise leave it null.
Set `type` when the value is a date, datetime or decimal.
Return {"filter": null} when the query implies no filter.
```

The briefing has one line per catalog key, in catalog order, for the first `maxKeys` keys:

```text
- ns=cms key=category type=string(enum) — Help center section; values: billing, account, shipping
- ns=cms key=published type=date — Publication date
```

- `type` is the declared type for a registered key with a declared type, followed by the declared format and `multi` in parentheses when set. Otherwise it is the observed types joined by `|`, with the format in parentheses when there is exactly one observed entry and it has a format, or `unknown` when nothing is observed.
- The description is `(no description)` when empty.
- `values` lists `allowedValues` when the key has any, otherwise the key's top values, cut to `maxValuesPerKey`. The part is omitted when there are none.

### Response

The response must be a chat completion whose `choices[0].message.content` is a JSON object with a `filter` field:

```json
{ "choices": [ { "message": { "content": "{\"filter\": {\"ns\": \"cms\", \"key\": \"category\", \"op\": \"equals\", \"value\": \"billing\"}}" } } ] }
```

| Check | Failure |
|---|---|
| `choices[0].message.content` is a string | `FilterModelResponseError`: `` response is missing `choices[0].message.content` `` |
| The content parses as JSON | `FilterModelResponseError`: `message content is not valid JSON` |
| The parsed value is an object with a `filter` field | `FilterModelResponseError`: ``message content has no `filter` field`` |

### Retries

| Failure | Retried |
|---|---|
| HTTP `429` or `500` and higher | Yes |
| Error named `TypeError` (how `fetch` reports a network failure) | Yes |
| Timeout (error name `AbortError`) | Yes |
| Other non-`2xx` statuses, `FilterModelResponseError`, any other error | No |
| Any failure after `ctx.signal` has been aborted | No |

A request is attempted at most `1 + maxRetries` times (2 with the defaults). If `ctx.signal` aborts during a backoff wait, no further request is sent and the last error is thrown.

### Errors

<!-- no-check -->
```ts
class FilterModelApiError extends Error {
  readonly status: number;
}
class FilterModelResponseError extends Error {}
```

| Class | When | `name` | Message |
|---|---|---|---|
| `FilterModelApiError` | Non-`2xx` response. `status` holds the HTTP status. | `"FilterModelApiError"` | `Filter model API error <status>: <response body>` |
| `FilterModelResponseError` | `2xx` response that fails the checks above. Never retried. | `"FilterModelResponseError"` | Starts with `Filter model response error: ` |

Inside `RagPipeline` these errors do not fail the search: the generated filter is dropped and `generatedFilterStatus` is `"error"`. They reach your code only when you call `generateFilter()` directly.

## Related

- [Generate filters automatically](/how-to/auto-filter)
- [Filter by metadata](/how-to/filter-by-metadata)
- [Filter grammar](/reference/filter-grammar)
- [Metadata model](/explanation/metadata-model)
