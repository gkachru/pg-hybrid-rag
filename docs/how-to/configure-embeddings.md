# Configure embeddings

The vector leg needs an embedding model for both indexing and search. This guide covers choosing a model and dimension, configuring `OpenAiCompatibleEmbedder` (batching, concurrency, timeouts, retries, prefixes), writing your own `EmbeddingProvider`, and changing models later.

## Before you begin

- An embedding endpoint. `OpenAiCompatibleEmbedder` works with any server that implements the OpenAI embeddings API: a hosted API, or a self-hosted server such as Hugging Face Text Embeddings Inference (TEI) or Infinity.
- If you haven't run migrations yet, decide on the dimension first (step 1). It is fixed when the tables are created.

## Steps

### 1. Choose a model and its dimension

`recommendForLanguage` returns a starting point for a language: a model, its dimension, its maximum input length and a `vectorMinScore`.

```ts
import { recommendForLanguage } from "pg-hybrid-rag";

const rec = recommendForLanguage("de");
// rec.embedder        "BAAI/bge-m3"
// rec.dimensions      1024
// rec.maxTokens       8192   (truncation ceiling, not a chunk size)
// rec.vectorMinScore  0.4
```

It returns the same model for every language, with the language-specific flags (`stemming`, `needsNormalization`, `isCjk`) set per language. `stemming` and `isCjk` match the exact code, as the database routes it (`en-GB` reports `stemming: "none"`); `needsNormalization` uses the base code. Treat the values as a starting point and validate them on your own queries.

Keep these constraints in mind:

- **One dimension per database.** All tenants share the `rag_documents.embedding vector(N)` column. Models with different dimensions need separate databases.
- **pgvector indexes vectors up to 2,000 dimensions.** Migration 003 creates an IVFFlat index on the column, so a larger dimension (for example 3,072) fails there.
- **Queries and documents must use the same model.** Vectors from different models aren't comparable.

### 2. Create the tables with that dimension

```ts
import { ragMigrate, recommendForLanguage, type TransactionProvider } from "pg-hybrid-rag";

declare const migrationProvider: TransactionProvider;
declare const sqlDir: string; // the package's sql/ directory; see "Run migrations"

const rec = recommendForLanguage("en");
await ragMigrate(migrationProvider, { sqlDir, embeddingDimensions: rec.dimensions });
```

The default is `384`. The option only applies on a fresh install. See [Run migrations](/how-to/run-migrations).

### 3. Construct the embedder

```ts
import { OpenAiCompatibleEmbedder } from "pg-hybrid-rag";

const embedder = new OpenAiCompatibleEmbedder({
  baseUrl: "http://localhost:8080/v1",
  apiKey: "change-me",
  model: "BAAI/bge-m3",
});
```

The embedder sends `POST ${baseUrl}/embeddings` with the body `{ input, model }` and the header `Authorization: Bearer ${apiKey}`. Include the API version path in `baseUrl` (usually `/v1`). For a local server that has no authentication, any `apiKey` string works.

| Option | Default | What to set it to |
| --- | --- | --- |
| `queryPrefix` | `"query"` | The model's query instruction, without the colon. |
| `documentPrefix` | `"passage"` | The model's document instruction, without the colon. |
| `batchSize` | `32` | Texts per request. Keep it at or below the server's per-request input limit. |
| `concurrency` | `1` | Requests in flight at once during `embedDocuments`. |
| `timeoutMs` | `30000` | Per-request timeout. `0` disables it. |
| `maxRetries` | `2` | Retries after the first attempt. |
| `retryBaseDelayMs` | `250` | Backoff base. Retry *n* waits `retryBaseDelayMs × 2^(n-1)`: 250 ms, then 500 ms. |

`batchSize` and `concurrency` must be positive; the constructor throws otherwise. See the [OpenAiCompatibleEmbedder reference](/reference/embedder) for the full list.

### 4. Set the prefixes for your model

The embedder sends `${queryPrefix}: ${text}` for queries and `${documentPrefix}: ${text}` for documents. An empty prefix sends the text unchanged. The defaults match the e5 model family.

| Model family | `queryPrefix` | `documentPrefix` |
| --- | --- | --- |
| e5 (`intfloat/multilingual-e5-*`) | `"query"` (default) | `"passage"` (default) |
| nomic-embed-text | `"search_query"` | `"search_document"` |
| Models that expect raw text | `""` | `""` |

In 0.2.5 and earlier, an empty prefix is still sent with its separator (`": text"`); on those versions, implement `EmbeddingProvider` yourself to send unprefixed text.

### 5. (Optional) Write your own `EmbeddingProvider`

Implement the two-method interface when you need a request field the built-in embedder doesn't send (such as `dimensions`), a different API shape, or an in-process model.

```ts
import type { EmbeddingProvider } from "pg-hybrid-rag";

class RawTextEmbedder implements EmbeddingProvider {
  constructor(
    private readonly url: string,
    private readonly model: string,
  ) {}

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    return vector;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) {
      vectors.push(...(await this.embed(texts.slice(i, i + 32))));
    }
    return vectors;
  }

  private async embed(input: string[]): Promise<number[][]> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, model: this.model }),
    });
    if (!res.ok) throw new Error(`Embedding request failed: ${res.status}`);
    const body = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

const embedder = new RawTextEmbedder("http://localhost:8080/v1/embeddings", "BAAI/bge-m3");
```

`embedDocuments` must return exactly one vector per input, in input order. `RagIndexer.index` throws if the count differs.

### 6. Set `vectorMinScore` for the model

The vector leg drops chunks whose cosine similarity is below `vectorMinScore`. The default, `0.8`, is calibrated for e5 models. Other models often score relevant chunks lower, so the default can silently empty the vector leg. Pass a value suited to your model on each search:

```ts
await pipeline.search(query, { language: "en", vectorMinScore: 0.4 });
```

See [Tune relevance](/how-to/tune-relevance) to calibrate it.

## Handle embedding errors

| Failure | Retried | Error thrown |
| --- | --- | --- |
| HTTP 429 or 5xx | Yes | `EmbeddingApiError` (has `status`) |
| Network error or timeout | Yes | The underlying `TypeError` or `AbortError` |
| Other HTTP 4xx (for example 400, 401, 413) | No | `EmbeddingApiError` |
| HTTP 200 with a body that isn't `{ data: [{ embedding }] }`, the wrong number of embeddings, or bad `index` values | No | `EmbeddingResponseError` |

`timeoutMs` applies to each attempt, so a call can take up to `(maxRetries + 1) × timeoutMs` plus backoff. If the server caps the number of inputs per request (for example TEI's `--max-client-batch-size`), set `batchSize` at or below that cap; the default of 32 can exceed it. A 4xx response other than 429 is not retried.

## Change the embedding dimension

Switching to a model with a different dimension means re-embedding every chunk.

1. Create a new database with `ragMigrate(provider, { sqlDir, embeddingDimensions: N })` and re-index into it, then switch traffic. This avoids downtime.
2. Or change the column in place, as the table owner. This deletes all indexed content:

   ```sql
   BEGIN;
   DELETE FROM rag_documents;
   DROP INDEX IF EXISTS idx_rag_embedding_ivfflat;
   ALTER TABLE rag_documents ALTER COLUMN embedding TYPE vector(1024);
   COMMIT;
   ```

   Re-index all sources with the new model, then recreate the vector index:

   ```sql
   CREATE INDEX idx_rag_embedding_ivfflat
     ON rag_documents USING ivfflat (embedding vector_cosine_ops)
     WITH (lists = 100);
   ```

   If you use VectorChord, drop and recreate `idx_rag_embedding_vchordrq` instead (definition in `sql/010_vectorchord.sql`).

Changing to a model with the same dimension needs no schema change, but you still need to re-index every source.

## Related

- [Run migrations](/how-to/run-migrations)
- [Chunk and index documents](/how-to/index-documents)
- [Tune relevance](/how-to/tune-relevance)
- [OpenAiCompatibleEmbedder reference](/reference/embedder)
- [Utilities reference](/reference/utilities)
- [Hybrid search](/explanation/hybrid-search)
