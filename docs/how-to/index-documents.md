# Chunk and index documents

This guide covers splitting documents into chunks with `Chunker`, indexing them with `RagIndexer`, re-indexing and deleting sources, mixed-language documents, FAQ content, and plugging in your own chunker.

## Before you begin

- Migrations have run. See [Run migrations](/how-to/run-migrations).
- You have an `EmbeddingProvider` and a `PostgresRagDatabase`. See [Configure embeddings](/how-to/configure-embeddings) and [Connect your database driver](/how-to/connect-database-driver).
- Your tenant ID and each source ID are UUID strings. `tenant_id` and `source_id` are `UUID` columns, so a value such as `"article-42"` fails with `invalid input syntax for type uuid`. If your IDs aren't UUIDs, see [Map your IDs to UUIDs](#map-your-ids-to-uuids). `source_type` is free text of up to 50 characters.

## Steps

### 1. Create a chunker

Token-limit mode converts a token budget into a per-language character limit:

```ts
import { Chunker } from "pg-hybrid-rag";

const chunker = new Chunker({ tokenLimit: 512, overlap: 75 });
```

Character mode takes a fixed size in characters for every language:

```ts
import { Chunker } from "pg-hybrid-rag";

const chunker = new Chunker(1200, 75); // chunkSize 1200 chars, overlap 75 chars
```

| Setting | Default | Notes |
| --- | --- | --- |
| `tokenLimit` | none | Token-limit mode only. Keep it well below your embedding model's maximum input; the model truncates longer input. |
| `chunkSize` (first constructor argument) | `512` | Character mode only. |
| `overlap` | `75` | Characters carried from the end of one chunk into the next, aligned to a word boundary. `0` disables overlap. |
| `prefixFn` | none | Token-limit mode only. See step 3. |

The size is a target, not a hard cap: overlap and a `prefixFn` label can push a chunk slightly over it, so leave headroom.

### 2. Chunk with metadata

```ts
const chunks = chunker.chunk(text, { language: "en", title: "Reset your password" });
```

The chunker splits on blank lines first, then on sentence ends, then at a fixed size for long runs with no delimiter. Every chunk gets the same `metadata` object. The library stores it as JSON with each row and returns it as `RagResult.metadata`.

`metadata.language` does two jobs: in token-limit mode it picks the characters-per-token ratio, and at index time it becomes the row's `language`, which selects the PostgreSQL stemmer for that chunk. Use the language codes in the [Languages reference](/reference/languages).

### 3. (Optional) Prefix chunks with a label

A label such as the document title gives every chunk context that the chunk text alone may lack:

```ts
import { Chunker } from "pg-hybrid-rag";

const chunker = new Chunker({
  tokenLimit: 512,
  prefixFn: (m) => (m.title ? `[${m.title}]` : undefined),
});

const chunks = chunker.chunk(text, { language: "en", title: "Reset your password" });
// chunks[0].content === "[Reset your password] ..."
```

`prefixFn` receives the metadata once per `chunk()` call. The label is added after sizing and doesn't count toward the limit, so keep it short.

### 4. Index the chunks

```ts
import { RagIndexer } from "pg-hybrid-rag";

const indexer = new RagIndexer({ tenantId, db, embedder });

const articleId = "5b0e8c2a-3f4d-4a8e-9a63-0c7b1d2e4f51";
const count = await indexer.index("article", articleId, chunks, "en");
```

`index(sourceType, sourceId, chunks, language = "en", { attributes })` embeds all chunks, then replaces the source's existing rows in one transaction and returns the number of chunks written. Each row's language is the chunk's `metadata.language`, falling back to the `language` argument.

To attach typed attributes for filtering, pass `{ attributes }` as the fifth argument. See [Filter by metadata](/how-to/filter-by-metadata).

If the pipeline uses a `normalizer` or `segmenter`, give the indexer the same one. The lexical legs only match when content and queries are processed the same way. See [Search multilingual content](/how-to/multilingual-search).

## Map your IDs to UUIDs

If your content IDs aren't UUIDs (for example `"article-42"` or a numeric key), derive a deterministic UUID from them. A name-based UUID (version 5) maps the same input to the same UUID every time, so re-indexing and deleting find the same rows:

```ts
import { createHash } from "node:crypto";

// RFC 4122 version 5 UUID of `name` within `namespace` (itself a UUID).
function uuidV5(name: string, namespace: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Pick one namespace UUID for your application and never change it.
const ID_NAMESPACE = "4f8c2a7e-0b1d-4c3e-9a6f-2d5b7e8c1a90";

const sourceId = uuidV5("article-42", ID_NAMESPACE);
await indexer.index("article", sourceId, chunks, "en");
```

The `v5` function of the `uuid` npm package produces the same result. `RagResult.sourceId` returns the UUID, so keep a way to map it back to your own ID, such as storing your ID in the chunk `metadata`.

## Re-index a source

Call `index()` again with the same `sourceType` and `sourceId`. The delete of the old chunks and the insert of the new ones run in one transaction, so a failed insert leaves the old chunks in place.

If the document is now empty, `index()` with an empty `chunks` array deletes the source's existing chunks, logs "Documents indexed" with `chunks: 0`, and returns `0` without calling the embedder. In 0.6.0 and earlier it returned `0` and left the old chunks in place; on those versions call `deleteSource` instead.

## Delete a source

```ts
await indexer.deleteSource("article", "5b0e8c2a-3f4d-4a8e-9a63-0c7b1d2e4f51");
```

## Index a document in several languages

Chunk each language section separately so each gets the right size and stemmer, then renumber the chunks so their indexes stay unique within the source:

```ts
import { Chunker } from "pg-hybrid-rag";

declare const englishText: string;
declare const spanishText: string;

const chunker = new Chunker({ tokenLimit: 512 });
const combined = [
  ...chunker.chunk(englishText, { language: "en" }),
  ...chunker.chunk(spanishText, { language: "es" }),
].map((chunk, i) => ({ ...chunk, index: i }));

await indexer.index("article", "5b0e8c2a-3f4d-4a8e-9a63-0c7b1d2e4f51", combined, "en");
```

## Index FAQ entries

Index the question together with the answer, not the answer alone. Users phrase queries like questions, and including the question text gives both the lexical and vector legs that phrasing to match.

```ts
import { Chunker } from "pg-hybrid-rag";

declare const faq: { id: string; question: string; answer: string };

const chunker = new Chunker({ tokenLimit: 512 });
const faqChunks = chunker.chunk(`${faq.question}\n\n${faq.answer}`, { language: "en" });
await indexer.index("faq", faq.id, faqChunks, "en");
```

## Index many sources

Each `index()` call embeds one source's chunks (batched by the embedder) and writes them in one `INSERT`. To index a large corpus, run several sources at a time with a concurrency limit that your embedding server and connection pool can absorb:

```ts
declare const docs: Array<{ id: string; text: string }>;

const LIMIT = 4;
for (let i = 0; i < docs.length; i += LIMIT) {
  await Promise.all(
    docs.slice(i, i + LIMIT).map((doc) =>
      indexer.index("article", doc.id, chunker.chunk(doc.text, { language: "en" }), "en"),
    ),
  );
}
```

For background re-indexing, call `index()` from your job queue worker; the library doesn't include a queue.

## Use your own chunker

Implement `ChunkingProvider` to use another splitting strategy or library. Return `Chunk` objects with `content`, a zero-based `index`, and `metadata` (include `language`):

```ts
import type { Chunk, ChunkingProvider } from "pg-hybrid-rag";

// Splits a Markdown document at level-2 headings.
const headingChunker: ChunkingProvider = {
  chunk(text: string, metadata: Record<string, string> = {}): Chunk[] {
    return text
      .split(/\n(?=## )/)
      .map((section) => section.trim())
      .filter(Boolean)
      .map((content, index) => ({ content, index, metadata }));
  },
};

const sections = headingChunker.chunk(text, { language: "en" });
await indexer.index("wiki", "0f6c1e7a-8d2b-4c55-b1e9-6a3f2d7c9b10", sections, "en");
```

A custom chunker has to keep chunks below the embedding model's input limit itself.

For Thai, Chinese, Japanese and Korean, `Chunker.chunkSegmented` finds word boundaries with a `Segmenter`. See [Search Chinese, Japanese, Korean and Thai](/how-to/cjk-and-segmentation).

## Related

- [Configure embeddings](/how-to/configure-embeddings)
- [Filter by metadata](/how-to/filter-by-metadata)
- [Search multilingual content](/how-to/multilingual-search)
- [Chunker reference](/reference/chunker)
- [RagIndexer reference](/reference/rag-indexer)
- [Language processing](/explanation/language-processing)
