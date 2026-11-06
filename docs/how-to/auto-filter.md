# Generate filters from the query

This guide shows how to let a language model turn a query such as "EU refund rules from 2026" into a metadata filter. You register the keys the model may use, connect a filter model, enable `autoFilter` on a search, and read diagnostics to see what the model produced.

For why the generated filter is validated, ANDed with your explicit filter, and dropped when invalid, see [Metadata model](/explanation/metadata-model).

## Before you begin

- Index documents with attributes. See [Filter search results by metadata](/how-to/filter-by-metadata).
- Have a chat completions endpoint that supports structured output with `response_format: { type: "json_schema", strict: true }`, or write your own filter model (see [Write a custom filter model](#write-a-custom-filter-model)).
- Migration 018 (the key registry) applies by default. If you run `ragMigrate` with `rls: true` (see [Run migrations](/how-to/run-migrations)), migration 019 adds row-level security to the registry and migration 021 applies it to the table owner too.

## Register the keys the model may use

`CachingMetadataCatalog` describes a tenant's keys: those observed in indexed attributes, with document counts and the most common string values, merged with the keys you register.

```ts
import { CachingMetadataCatalog } from "pg-hybrid-rag";

const catalog = new CachingMetadataCatalog({ txProvider });

await catalog.register(tenantId, [
  {
    ns: "cms",
    key: "region",
    description: "Sales region the article applies to",
    type: "string",
    format: "enum",
    multi: true,
    allowedValues: ["EU", "UK", "US"],
  },
  {
    ns: "cms",
    key: "effective_date",
    description: "Date the policy takes effect",
    type: "date",
  },
]);
```

- `description` is required and is what the model reads, so write it for the model.
- `allowedValues` is valid only for string keys. Generated `equals` conditions on that key must use one of these values.
- `register` upserts by `(ns, key)` and throws an `Error` listing every invalid entry. `unregister(tenantId, [{ ns, key }])` removes entries; observed keys stay in the catalog as unregistered.
- `tenantId` must be a UUID; the registry column is typed `uuid`.

Check what the model will see:

```ts
import type { CachingMetadataCatalog } from "pg-hybrid-rag";

declare const catalog: CachingMetadataCatalog;

const described = await catalog.describe(tenantId);
for (const key of described.keys) {
  console.log(key.ns, key.key, key.registered, key.observed, key.topValues);
}
```

### Catalog caching

| Option | Default | Effect |
| --- | --- | --- |
| `ttlMs` | `300000` (5 minutes) | Age after which `describe()` refreshes the entry |
| `topValuesPerKey` | `20` | Most common string values reported per key |

The first `describe()` for a tenant waits for the load. After `ttlMs`, `describe()` returns the cached catalog at once and refreshes it in the background; a failed refresh keeps the old entry. `register`, `unregister` and `invalidate(tenantId)` drop the entry, so the next call loads fresh data. Changes made by other processes, and newly indexed keys, show up after the TTL or after you call `invalidate(tenantId)`.

## Create a filter model

`OpenAiCompatibleFilterModel` posts to `${baseUrl}/chat/completions` with `temperature: 0` and a strict JSON schema (`FILTER_GENERATION_SCHEMA`). The system prompt includes a briefing rendered from the catalog.

```ts
import { OpenAiCompatibleFilterModel } from "pg-hybrid-rag";

declare const apiKey: string;

const filterModel = new OpenAiCompatibleFilterModel({
  baseUrl: "https://api.example.com/v1",
  model: "your-model",
  apiKey,
  timeoutMs: 1200,
  maxRetries: 1,
});
```

| Option | Default | Effect |
| --- | --- | --- |
| `baseUrl` | required | API base; the request goes to `${baseUrl}/chat/completions` |
| `model` | required | Model name sent in the request |
| `apiKey` | none | Sent as `Authorization: Bearer <apiKey>` |
| `timeoutMs` | `10000` | Per-request timeout; `0` disables it |
| `maxRetries` | `1` | Retries after the first attempt, on HTTP 429/5xx, network errors and timeouts |
| `retryBaseDelayMs` | `250` | Exponential backoff base between retries |
| `maxTokens` | unset | Sent as `max_tokens` when set; must be a positive integer |
| `briefing` | `{ maxKeys: 100, maxValuesPerKey: 20 }` | How much of the catalog goes into the prompt |
| `systemPrompt` | built-in prompt | Replaces the instructions; the catalog briefing is still appended |

`maxTokens` is omitted by default because some models reject `max_tokens`.

## Configure the pipeline

Give the pipeline both the catalog and the model. `filterTimeoutMs` (default `3000`, `0` disables) is the total time allowed for `describe()` plus the model call, including the model's retries.

```ts
import { CachingMetadataCatalog, OpenAiCompatibleFilterModel, RagPipeline } from "pg-hybrid-rag";

declare const catalog: CachingMetadataCatalog;
declare const filterModel: OpenAiCompatibleFilterModel;

const pipeline = new RagPipeline({
  tenantId,
  db,
  embedder,
  metadataCatalog: catalog,
  filterModel,
  filterTimeoutMs: 3000,
});
```

## Search with autoFilter

Set `autoFilter: true`. Use `searchWithDiagnostics()` to see what happened to the generated filter.

```ts
const { results, diagnostics } = await pipeline.searchWithDiagnostics("EU refund rules from 2026", {
  language: "en",
  autoFilter: true,
  filter: { ns: "cms", key: "published", op: "equals", value: true }, // optional, ANDed
});

if (diagnostics.generatedFilterStatus !== "applied") {
  logger.info(
    { status: diagnostics.generatedFilterStatus, errors: diagnostics.generatedFilterErrors },
    "Generated filter not used",
  );
}
```

Filter generation runs concurrently with query embedding. What happens next depends on the model's output:

| `generatedFilterStatus` | Meaning | Search runs with |
| --- | --- | --- |
| `not_requested` | `autoFilter` was off | Explicit filter only |
| `none` | The model returned `null` (no filter implied) | Explicit filter only |
| `applied` | The generated filter passed validation | Explicit AND generated filter |
| `invalid` | The generated filter failed validation; `generatedFilterErrors` says why | Explicit filter only |
| `error` | The model or catalog threw, or `filterTimeoutMs` expired | Explicit filter only |

Validation of a generated filter rejects keys absent from the catalog and `equals` string values outside a key's `allowedValues`. `diagnostics.generatedFilter` holds the raw model output in every case.

### Retry when the generated filter empties the results

When an applied generated filter leaves all three legs empty, the pipeline searches once more with only the explicit filter. `diagnostics.retriedWithoutGeneratedFilter` is then `true`, and `generatedFilterStatus` stays `"applied"`. To return the empty result instead, set `autoFilterRetryOnEmpty: false`:

```ts
await pipeline.search("EU refund rules from 2026", {
  language: "en",
  autoFilter: true,
  autoFilterRetryOnEmpty: false,
});
```

## Fit the timeouts together

Three timers are involved:

- `filterTimeoutMs` on the pipeline (default 3000 ms) bounds the whole step. When it expires, the pipeline aborts `ctx.signal`, drops the generated filter (`status: "error"`) and continues the search.
- `timeoutMs` on `OpenAiCompatibleFilterModel` (default 10000 ms) bounds each request.
- `maxRetries` and `retryBaseDelayMs` add attempts and waits.

With the defaults, the 3-second pipeline deadline fires long before the model's 10-second request timeout, so a retry rarely gets to run. If you want a retry to fit, size the attempts inside the deadline. With `timeoutMs: 1200`, `maxRetries: 1` and `retryBaseDelayMs: 250`, the worst case is 1200 + 250 + 1200 = 2650 ms of model time, leaving 350 ms of the 3000 ms deadline for `describe()`.

`OpenAiCompatibleFilterModel` does not start another attempt after `ctx.signal` aborts.

## Write a custom filter model

Implement `FilterModelProvider`. Return a filter expression, or `null` when the query implies none. The return type is `unknown` on purpose: the pipeline validates whatever you return against the catalog before using it. Honor `ctx.signal` so a timed-out call stops work.

This provider needs no language model. It turns a year in the query into a date range when the catalog has a matching key:

```ts
import type { FilterModelProvider } from "pg-hybrid-rag";

const yearFilter: FilterModelProvider = {
  async generateFilter(query, catalog) {
    const year = /\b(20\d{2})\b/.exec(query)?.[1];
    const hasKey = catalog.keys.some((k) => k.ns === "cms" && k.key === "effective_date");
    if (!year || !hasKey) return null;
    return {
      ns: "cms",
      key: "effective_date",
      op: "between",
      value: [`${year}-01-01`, `${year}-12-31`],
    };
  },
};
```

For an LLM API with a different request format, call it from `generateFilter` and use the exported `FILTER_JSON_SCHEMA` (lenient) or `FILTER_GENERATION_SCHEMA` (strict, every property required and nullable) as the output schema. Both describe an object `{ filter: <expression> | null }`; return its `filter` property.

## Gotchas

- `autoFilter: true` throws if the pipeline lacks `filterModel` or `metadataCatalog`, and throws `AttributeFiltersUnsupportedError` if the database cannot apply filters.
- An invalid explicit `filter` throws `FilterValidationError`. An invalid generated filter never throws; it is dropped and logged with `warn`. Watch `generatedFilterStatus` to see how often that happens.
- The model receives the raw query and the catalog briefing, which includes key names, descriptions and the most common string values from the tenant's documents. Account for that when you choose where the model runs.
- `filterTimeoutMs` must be between `0` and `2147483647`; the constructor throws otherwise.

## Related

- [Filter search results by metadata](/how-to/filter-by-metadata)
- [Monitor searches](/how-to/observability)
- [Metadata catalog reference](/reference/metadata-catalog)
- [Filter grammar reference](/reference/filter-grammar)
- [Metadata model](/explanation/metadata-model)
