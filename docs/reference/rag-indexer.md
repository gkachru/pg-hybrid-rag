# RagIndexer

`RagIndexer` writes chunks for one tenant: it embeds them, computes the normalized text used by the lexical legs, attaches typed attributes, and replaces the source's existing chunks in one transaction. This page covers the constructor, `index()` and `deleteSource()`.

```ts
import { Chunker, PostgresRagDatabase, RagIndexer } from "pg-hybrid-rag";

const indexer = new RagIndexer({
  tenantId,
  db: new PostgresRagDatabase(txProvider),
  embedder,
});

const chunks = new Chunker({ tokenLimit: 512 }).chunk(text, { language: "en" });
const count = await indexer.index("article", "3f2b8c1e-5d4a-4b7e-9c2f-1a6d8e0b4c71", chunks, "en", {
  attributes: [{ ns: "cms", key: "category", type: "string", value: "billing" }],
});
```

## Constructor

<!-- no-check -->
```ts
new RagIndexer(config: RagIndexerConfig)
```

### RagIndexerConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `tenantId` | `string` | required | Tenant that owns the written rows. With `PostgresRagDatabase` it must be a UUID string (the `tenant_id` column is `UUID`). |
| `db` | `RagDatabase` | required | Stores and deletes chunks. Usually a [`PostgresRagDatabase`](/reference/postgres-rag-database). |
| `embedder` | `EmbeddingProvider` | required | Embeds chunk content with `embedDocuments()`. |
| `normalizer` | `Normalizer` | none | Lexical normalizer applied to each chunk's content to build `content_normalized`. Use the same normalizer on `RagPipeline`. |
| `segmenter` | `Segmenter` | none | Word segmenter applied after the normalizer to build `content_normalized`. Use the same instance on `RagPipeline` and `PostgresRagDatabase`. |
| `logger` | `RagLogger` | no-op | Receives one `info` call per successful `index()`. |
| `attributeLimits` | `Partial<AttributeLimits>` | `DEFAULT_ATTRIBUTE_LIMITS` | Overrides for the per-article attribute limits. Defaults: `maxAttributes` 50, `maxValuesPerAttribute` 20, `maxStringLength` 256. See [Filter grammar](/reference/filter-grammar). |

The constructor does not validate its input.

## Methods

### index()

<!-- no-check -->
```ts
index(
  sourceType: string,
  sourceId: string,
  chunks: Chunk[],
  language?: string, // default "en"
  options?: { attributes?: AttributeInput[] },
): Promise<number>
```

Replaces every stored chunk of `(sourceType, sourceId)` for the indexer's tenant with `chunks`.

| Parameter | Type | Description |
|---|---|---|
| `sourceType` | `string` | Source category, stored in `source_type` (for example `"article"`, `"faq"`). With `PostgresRagDatabase` it is a `VARCHAR(50)`, so at most 50 characters. |
| `sourceId` | `string` | Source identifier, stored in `source_id`. With `PostgresRagDatabase` it must be a UUID string (the column is `UUID`); other values fail with `invalid input syntax for type uuid`. |
| `chunks` | `Chunk[]` | Chunks to store, usually from [`Chunker`](/reference/chunker). |
| `language` | `string` | Fallback language for chunks whose `metadata.language` is not set. Default `"en"`. |
| `options.attributes` | `AttributeInput[]` | Typed attributes for the whole article. The same attributes are stored on every chunk row. Default `[]`. |

Returns the number of chunks written (`chunks.length`).

Steps, in order:

1. If `chunks` is empty, the source now has no content: call `db.deleteBySource()` to delete its existing chunks, log `info` (`Documents indexed`, with `chunks: 0`) and return `0`. Nothing is embedded, and `options.attributes` is not validated.
2. Validate and normalize `options.attributes` against `attributeLimits`, before any embedding.
3. Embed all chunk contents with one `embedder.embedDocuments()` call (the embedder does its own batching).
4. Check that the embedder returned exactly one vector per chunk.
5. Build one row per chunk:
   - `content`: the chunk content as given, used for display and the vector leg.
   - `content_normalized`: `normalizer.normalize(content, lang)`, then `segmenter.segment(..., lang)`, each only when configured. Without either it equals `content`.
   - `language`: `chunk.metadata.language`, else the `language` argument. The tsvector trigger stems each row with this language.
   - `chunk_index`: `String(chunk.index)`.
   - `metadata`: `JSON.stringify(chunk.metadata)`.
   - `attributes`: the serialized attributes from step 2.
6. Call `db.replaceSource()`, which deletes the source's old rows and inserts the new ones in one transaction.
7. Log `info` with `tenantId`, `sourceType`, `sourceId` and `chunks`.

#### Errors

| Condition | Error |
|---|---|
| An attribute is invalid or over a limit | `AttributeValidationError`, before any embedding (see [Errors](/reference/errors#attributevalidationerror)) |
| The embedder rejects | The embedder's error. Nothing is written. |
| The embedder returns a different number of vectors than chunks | `Error`: `Embedder returned <n> embeddings for <m> chunks`. Nothing is written. |
| `db.replaceSource()` rejects | The database error. With `PostgresRagDatabase` the transaction is rolled back, so the old chunks remain. |

### deleteSource()

<!-- no-check -->
```ts
deleteSource(sourceType: string, sourceId: string): Promise<void>
```

Deletes every chunk of `(sourceType, sourceId)` for the indexer's tenant by calling `db.deleteBySource()`. Database errors propagate.

```ts
await indexer.deleteSource("article", "3f2b8c1e-5d4a-4b7e-9c2f-1a6d8e0b4c71");
```

## Related

- [Chunker](/reference/chunker)
- [PostgresRagDatabase](/reference/postgres-rag-database)
- [Index documents](/how-to/index-documents)
- [Filter by metadata](/how-to/filter-by-metadata)
