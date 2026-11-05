# OpenAiCompatibleEmbedder

`OpenAiCompatibleEmbedder` is a fetch-based [`EmbeddingProvider`](/reference/interfaces) for any HTTP API that implements the OpenAI embeddings request and response format. It batches document requests, applies a per-request timeout, and retries transient failures. This page covers its configuration, the request and response format, the retry rules, and its two error classes.

```ts
import { OpenAiCompatibleEmbedder } from "pg-hybrid-rag";

const embedder = new OpenAiCompatibleEmbedder({
  baseUrl: "http://localhost:8080/v1",
  apiKey: "unused-for-local",
  model: "intfloat/multilingual-e5-small",
});

const vector = await embedder.embedQuery("how do I reset my password");
```

It uses the global `fetch` and works on Node and Bun.

## Constructor

<!-- no-check -->
```ts
new OpenAiCompatibleEmbedder(config: OpenAiCompatibleEmbedderConfig)
```

### OpenAiCompatibleEmbedderConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | required | API base URL. Requests go to `${baseUrl}/embeddings` (string concatenation), so this usually ends in `/v1` without a trailing slash. |
| `apiKey` | `string` | required | Sent as `Authorization: Bearer <apiKey>` on every request. |
| `model` | `string` | required | Sent as `model` in the request body. |
| `queryPrefix` | `string` | `"query"` | Prefix for `embedQuery()`. The text sent is `` `${queryPrefix}: ${text}` ``. |
| `documentPrefix` | `string` | `"passage"` | Prefix for `embedDocuments()`. The text sent is `` `${documentPrefix}: ${text}` ``. |
| `batchSize` | `number` | `32` | Maximum texts per request in `embedDocuments()`. |
| `concurrency` | `number` | `1` | Maximum requests in flight at once in `embedDocuments()`. |
| `timeoutMs` | `number` | `30000` | Per-request timeout. The request is aborted when it runs longer. `0` disables the timeout. |
| `maxRetries` | `number` | `2` | Retries after the first attempt, for retryable failures only. `0` disables retries. |
| `retryBaseDelayMs` | `number` | `250` | Base delay for exponential backoff. The wait before retry `n` (1-based) is `retryBaseDelayMs * 2^(n-1)`. |

The prefixes are always applied with a colon and a space. An empty prefix still sends `": <text>"`. The defaults match e5-family models; for a model that expects raw text, implement `EmbeddingProvider` yourself. See [Configure embeddings](/how-to/configure-embeddings).

`timeoutMs`, `maxRetries` and `retryBaseDelayMs` are not validated.

### Constructor errors

| Condition | Error |
|---|---|
| `batchSize` is not greater than 0 (including `NaN`) | `Error`: `OpenAiCompatibleEmbedder batchSize must be a positive number, got <value>` |
| `concurrency` is not greater than 0 (including `NaN`) | `Error`: `OpenAiCompatibleEmbedder concurrency must be a positive number, got <value>` |

## Methods

### embedQuery()

<!-- no-check -->
```ts
embedQuery(text: string): Promise<number[]>
```

Sends one request with `input: ["<queryPrefix>: <text>"]` and returns the single embedding.

### embedDocuments()

<!-- no-check -->
```ts
embedDocuments(texts: string[]): Promise<number[][]>
```

Prefixes every text with `documentPrefix`, splits them into batches of `batchSize`, and sends the batches in groups of `concurrency`: all requests in a group run in parallel, and the next group starts when the whole group has finished. Returns one embedding per input, in input order. If any request fails after its retries, the call rejects.

## Request and response

Each request is:

```text
POST {baseUrl}/embeddings
Content-Type: application/json
Authorization: Bearer {apiKey}
```

```json
{ "input": ["passage: first text", "passage: second text"], "model": "intfloat/multilingual-e5-small" }
```

A `2xx` response must be JSON of this shape:

```json
{ "data": [ { "embedding": [0.012, -0.034], "index": 0 }, { "embedding": [0.051, 0.007], "index": 1 } ] }
```

The response is validated before use:

| Check | Failure |
|---|---|
| `data` is an array | `EmbeddingResponseError`: ``response is missing a `data` array`` |
| `data.length` equals the number of inputs | `EmbeddingResponseError`: `expected <n> embedding(s) but received <m>` |
| Every `embedding` is an array of finite numbers | `EmbeddingResponseError`: ``an entry's `embedding` is not an array of finite numbers`` |
| If every entry has `index`: the indices are the integers `0` to `n-1`, each once | `EmbeddingResponseError`: ``response `index` values are not a 0..n-1 permutation`` |
| Either every entry has `index` or none does | `EmbeddingResponseError`: `response mixes indexed and non-indexed entries` |

When every entry has `index`, embeddings are reordered by `index`. When none has it, the response order is used. Other fields in the response are ignored.

A `2xx` response whose body is not valid JSON rejects with the runtime's JSON parse error, which is not retried.

## Retries

Each request (one batch, or the single `embedQuery` input) is retried independently.

| Failure | Retried |
|---|---|
| HTTP `429` | Yes |
| HTTP `500` or higher | Yes |
| Error named `TypeError` (how `fetch` reports a network failure) | Yes |
| Timeout (the request is aborted, error name `AbortError`) | Yes |
| Any other non-`2xx` status, for example `400`, `401`, `404` | No |
| `EmbeddingResponseError` | No |
| Any other error | No |

A request is attempted at most `1 + maxRetries` times. With the defaults: up to 3 attempts, waiting 250 ms and then 500 ms. After the last attempt the last error is thrown.

## Errors

### EmbeddingApiError

<!-- no-check -->
```ts
class EmbeddingApiError extends Error {
  readonly status: number;
}
```

Thrown for a non-`2xx` response. `name` is `"EmbeddingApiError"`, `status` is the HTTP status, and the message is `Embedding API error <status>: <response body>` (the body is empty if it cannot be read).

### EmbeddingResponseError

<!-- no-check -->
```ts
class EmbeddingResponseError extends Error {}
```

Thrown for a `2xx` response that fails the validation above. `name` is `"EmbeddingResponseError"` and the message starts with `Embedding API response error: `. Never retried.

```ts
import { EmbeddingApiError, EmbeddingResponseError } from "pg-hybrid-rag";

try {
  await embedder.embedDocuments(["first text", "second text"]);
} catch (err) {
  if (err instanceof EmbeddingApiError && err.status === 401) {
    // check the API key
  } else if (err instanceof EmbeddingResponseError) {
    // check baseUrl and the server's response format
  }
  throw err;
}
```

## Related

- [Configure embeddings](/how-to/configure-embeddings)
- [Errors](/reference/errors#embeddingapierror)
- [RagIndexer](/reference/rag-indexer)
