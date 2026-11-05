# Search Chinese, Japanese, Korean, and Thai text

This guide covers the two ways to get lexical matching for scripts that do not put spaces between words: the pg_bigm keyword path for Chinese, Japanese and Korean, and a word segmenter for any such language, including Thai.

For background on why whitespace-less scripts need special handling, see [Language processing](/explanation/language-processing).

## Choose an approach

| | pg_bigm path | Segmenter path |
| --- | --- | --- |
| Languages | Exactly `zh`, `zh-CN`, `ja`, `ja-JP`, `ko`, `ko-KR` | Any language your segmenter handles |
| Keyword leg | Share of the query's character bigrams found in raw `content` | pg_trgm word similarity on segmented `content_normalized` |
| Full-text leg | `simple` config on unsegmented text | `simple` config on space-separated words |
| Needs | pg_bigm extension, `cjk: true` on migration and adapter | A `Segmenter`, the same instance everywhere, a re-index |

You can use both: a language your segmenter handles takes the segmenter path, and other CJK codes take the pg_bigm path. The vector leg works the same either way.

## Use pg_bigm for CJK keyword search

### Before you begin

Install pg_bigm in your Postgres server. See [Prepare PostgreSQL](/how-to/prepare-postgres).

### Steps

1. Apply the CJK migration. It creates the `pg_bigm` extension and a GIN bigram index on `content`.

   ```ts
   import { ragMigrate, type TransactionProvider } from "pg-hybrid-rag";

   // Both come from "Run migrations": the package's sql/ directory and a pinned,
   // non-transactional provider connected as the schema owner.
   declare const sqlDir: string;
   declare const migrationProvider: TransactionProvider;

   // Pass the same flags you used before, plus this one.
   await ragMigrate(migrationProvider, { sqlDir, cjk: true });
   ```

   In 0.6.0, `ragMigrate` cannot find its SQL directory on its own when installed as a package, so always pass `sqlDir`. See [Run migrations](/how-to/run-migrations).

2. Enable the pg_bigm path on the adapter:

   ```ts
   import { PostgresRagDatabase, RagIndexer, RagPipeline } from "pg-hybrid-rag";

   const db = new PostgresRagDatabase(txProvider, { cjk: true });
   const indexer = new RagIndexer({ tenantId, db, embedder });
   const pipeline = new RagPipeline({ tenantId, db, embedder });
   ```

3. Chunk and index with a CJK language code. Token-limit mode sizes CJK chunks at about 1.2 characters per token.

   ```ts
   import { Chunker } from "pg-hybrid-rag";

   declare const articleId: string; // source IDs are UUIDs

   const chunker = new Chunker({ tokenLimit: 512 });
   const chunks = chunker.chunk(text, { language: "ja" });
   await indexer.index("article", articleId, chunks, "ja");
   ```

4. Search with the same code:

   ```ts
   const results = await pipeline.search("返品ポリシー", { language: "ja" });
   ```

On this path, `keywordMinScore` (default `0.35`) is the share of the query's character bigrams that a chunk must contain. Raise it to require closer matches; lower it to accept partial overlap.

### Gotchas

- Routing uses the query `language` and matches the six codes above exactly. `zh-TW`, `zh-Hant` or `ja-jp` stay on pg_trgm. Map such codes to one of the six before you search, and index with the same codes.
- Only the keyword leg changes. The full-text leg still parses unsegmented text with the `simple` config, so it contributes little for CJK queries.
- Bigram matching does not know word boundaries, so a query can match characters that span two words in the document.
- If `cjk: true` is set on the adapter but migration 009 was not applied, the keyword leg fails and so does the whole search.

## Use a word segmenter

A `Segmenter` inserts spaces at word boundaries. The library applies it to the lexical side only: `content_normalized` at index time and the keyword/full-text query at search time. The stored `content`, the embedding and the reranker input stay unsegmented.

### Steps

1. Create one segmenter. `IntlSegmenterAdapter` uses the runtime's `Intl.Segmenter`, with no extra dependencies:

   ```ts
   import { IntlSegmenterAdapter } from "pg-hybrid-rag";

   const segmenter = new IntlSegmenterAdapter({ languages: ["th"] });
   ```

   `languages` takes base codes; `"th"` also covers `"th-TH"`.

2. Pass the same instance to the adapter, the indexer, the pipeline and the chunker. The chunker accepts a segmenter only in token-limit mode.

   ```ts
   import {
     Chunker,
     IntlSegmenterAdapter,
     PostgresRagDatabase,
     RagIndexer,
     RagPipeline,
   } from "pg-hybrid-rag";

   const segmenter = new IntlSegmenterAdapter({ languages: ["th"] });

   const db = new PostgresRagDatabase(txProvider, { segmenter }); // routing only
   const indexer = new RagIndexer({ tenantId, db, embedder, segmenter });
   const pipeline = new RagPipeline({ tenantId, db, embedder, segmenter });
   const chunker = new Chunker({ tokenLimit: 512, segmenter });
   ```

3. Chunk with `chunkSegmented()`. It uses the segmenter to place chunk boundaries between words but returns natural, unsegmented text. It falls back to `chunk()` when there is no segmenter, no `metadata.language`, or a language the segmenter does not handle, so you can call it for every document.

   ```ts
   declare const articleId: string;

   const chunks = await chunker.chunkSegmented(text, { language: "th" });
   await indexer.index("article", articleId, chunks, "th");
   ```

4. Search with the same language code:

   ```ts
   const results = await pipeline.search("วิธีเปลี่ยนรหัสผ่าน", { language: "th" });
   ```

::: warning IntlSegmenterAdapter is a reference implementation
Its output depends on the ICU word-break dictionary in your Node or Bun build. Words missing from that dictionary, such as loanwords and product names, can be split into fragments. Check it on your own text, and use a dictionary-based or model-based segmenter behind the `Segmenter` interface if the splits are poor.
:::

### Write a custom segmenter

Implement two methods:

- `segment(text, language)` returns the text with spaces inserted at word boundaries, or the input unchanged for a language it does not handle. It may return a promise.
- `segmentsLanguage(language)` returns whether `segment` rewrites that language. The adapter uses it for routing only. It must agree with `segment`.

`segment` may only insert whitespace. It must not reorder, replace or drop any other character, and boundaries must fall between grapheme clusters. `chunkSegmented()` relies on this to map word boundaries back onto the original text.

The sample below calls a segmentation service you run. The endpoint and its request and response shapes are placeholders for your own service.

```ts
import type { Segmenter } from "pg-hybrid-rag";

class HttpSegmenter implements Segmenter {
  private readonly languages: Set<string>;

  constructor(
    private readonly baseUrl: string,
    languages: string[],
  ) {
    this.languages = new Set(languages);
  }

  segmentsLanguage(language: string): boolean {
    return this.languages.has(language.split("-")[0].toLowerCase());
  }

  async segment(text: string, language: string): Promise<string> {
    if (!this.segmentsLanguage(language) || text.trim() === "") return text;
    const res = await fetch(`${this.baseUrl}/segment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`Segmenter returned ${res.status}`);
    const { tokens } = (await res.json()) as { tokens: string[] };
    const segmented = tokens.join(" ");
    // Enforce the contract: only whitespace may differ from the input.
    if (segmented.replace(/\s+/g, "") !== text.replace(/\s+/g, "")) {
      throw new Error("Segmenter changed non-whitespace characters");
    }
    return segmented;
  }
}

const segmenter = new HttpSegmenter("http://localhost:8080", ["th"]);
```

A segmenter error is not caught by the library: it fails the `index()` call or the search. Add a timeout, as above, so a slow service fails fast.

## Keep segmentation consistent

- Use one segmenter instance for the adapter, indexer, pipeline and chunker. If they disagree, indexed text and queries are tokenized differently and the keyword leg may route to the wrong index.
- When you add, remove or change a segmenter, or change the languages it handles, re-index the affected sources. `content_normalized` keeps whatever the previous segmenter produced.
- To move a CJK language from pg_bigm to a segmenter, add it to the segmenter on all four objects and re-index. To move it back, remove it and re-index. Routing follows `segmentsLanguage()`, even when `cjk: true` is set.

## Related

- [Search across languages](/how-to/multilingual-search)
- [Index documents](/how-to/index-documents)
- [Prepare PostgreSQL](/how-to/prepare-postgres)
- [Chunker reference](/reference/chunker)
- [PostgresRagDatabase reference](/reference/postgres-rag-database)
