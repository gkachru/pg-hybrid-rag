# Chunker

`Chunker` splits text into chunks for indexing. It splits on paragraphs first, then sentences, then a fixed-size fallback, and carries a word-aligned overlap between chunks. It implements [`ChunkingProvider`](/reference/interfaces). This page covers both constructor forms, `chunk()`, `chunkSegmented()`, the token-limit table, overlap, `prefixFn`, and the size guarantees.

```ts
import { Chunker } from "pg-hybrid-rag";

// Character mode: 512-char chunks, 75-char overlap
const byChars = new Chunker();

// Token mode: character limit derived from the chunk's language
const byTokens = new Chunker({ tokenLimit: 512 });

const chunks = byTokens.chunk(text, { language: "en", title: "Reset your password" });
```

## Constructor

The constructor has two forms.

### Character mode

<!-- no-check -->
```ts
new Chunker(chunkSize?: number, overlap?: number)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `chunkSize` | `number` | `512` | Target maximum chunk length in characters, for every language. |
| `overlap` | `number` | `75` | Overlap in characters carried from one chunk into the next. `0` or less disables overlap. |

Character mode has no `prefixFn` and no segmenter. `chunkSegmented()` in this mode behaves like `chunk()`.

### Token mode

<!-- no-check -->
```ts
new Chunker(config: ChunkerConfig)
```

The object form is recognized by the presence of a `tokenLimit` property.

| `ChunkerConfig` field | Type | Default | Description |
|---|---|---|---|
| `tokenLimit` | `number` | required | Target maximum tokens per chunk. Converted to a per-language character limit (see [Characters per token](#characters-per-token)). |
| `overlap` | `number` | `75` | Overlap in characters (not tokens). `0` or less disables overlap. |
| `prefixFn` | `(metadata: Record<string, string>) => string \| undefined` | none | Returns a label prepended to every chunk. See [prefixFn](#prefixfn). |
| `segmenter` | `Segmenter` | none | Word segmenter used by `chunkSegmented()` to find word boundaries in scripts written without spaces. |

### Constructor errors

| Condition | Error |
|---|---|
| `tokenLimit` is not greater than 0 (including `NaN`) | `Error`: `Chunker tokenLimit must be a positive number, got <value>` |
| `chunkSize` is not greater than 0 (including `NaN`) | `Error`: `Chunker chunkSize must be a positive number, got <value>` |

An object without `tokenLimit` is treated as a `chunkSize` and fails the `chunkSize` check.

## Characters per token

In token mode the character limit is `Math.floor(tokenLimit * ratio)`, where the ratio comes from the base language of `metadata.language` (the part before `-`, lowercased, so `"pt-BR"` uses `pt`). Each ratio is an approximate characters-per-token figure multiplied by a 0.8 safety margin.

| Languages | Ratio | Limit at `tokenLimit: 512` |
|---|---|---|
| `en`, `es`, `fr`, `de`, `it`, `pt`, `ro`, `ms` | 3.2 | 1638 |
| `hi`, `ar`, `si` | 2.4 | 1228 |
| `th` | 1.5 | 768 |
| `zh`, `ja`, `ko` | 1.2 | 614 |
| any other language, or no `metadata.language` | 1 (limit = `tokenLimit`) | 512 |

These ratios are heuristics, not a tokenizer. Check the chunk sizes against your embedding model's tokenizer.

In character mode the language is ignored and the limit is always `chunkSize`.

Lengths are JavaScript string lengths (UTF-16 code units).

## Methods

### chunk()

<!-- no-check -->
```ts
chunk(text: string, metadata?: Record<string, string>): Chunk[]
```

| Parameter | Type | Description |
|---|---|---|
| `text` | `string` | Text to split. |
| `metadata` | `Record<string, string>` | Attached to every chunk (the same object). `metadata.language` selects the token-mode limit and is read by `RagIndexer` as the row language. Default `{}`. |

Returns `Chunk[]` with `content`, `index` (0, 1, 2, ...) and `metadata`. Returns `[]` when `text` is empty or whitespace only.

Algorithm:

1. Split `text` into paragraphs on two or more consecutive newlines (`\n\n+`), dropping blank paragraphs.
2. Pack paragraphs into a buffer joined by `\n\n` while the buffer stays within the limit.
3. When the next paragraph does not fit, emit the buffer, start the next buffer with the overlap from the emitted chunk, and continue.
4. A paragraph longer than the limit is split into sentences on whitespace that follows `.`, `!`, `?`, `।`, `。`, `！` or `？`, and the sentences are packed the same way.
5. A sentence still longer than the limit (a long URL, a CSV row, a run of text with no terminator) is cut into fixed-size slices on grapheme-cluster boundaries.
6. Apply `prefixFn`, if set.

### chunkSegmented()

<!-- no-check -->
```ts
chunkSegmented(text: string, metadata?: Record<string, string>): Promise<Chunk[]>
```

Word-aware chunking for scripts written without spaces between words, such as Thai, Chinese and Japanese. It uses the configured `segmenter` only to find word boundaries; the chunk content is the original, unsegmented text.

It returns the same result as `chunk()` when any of these holds:

- no `segmenter` is configured,
- `metadata.language` is not set,
- `segmenter.segmentsLanguage(metadata.language)` returns `false`.

Otherwise:

1. Split into paragraphs on `\n\n+` and pack them into the buffer while it fits. A paragraph boundary flushes the buffer without carrying overlap.
2. A paragraph longer than the limit is passed to `segmenter.segment()`, mapped back to the original text as word units, and packed into chunks at word boundaries. The overlap is the last word plus earlier whole words while the total stays within `overlap` characters; the last word is carried even when it alone is longer than `overlap`.
3. A single word longer than the limit is split on grapheme-cluster boundaries.
4. Apply `prefixFn`, if set.

The segmenter must follow the space-insertion contract on [Interfaces](/reference/interfaces): it may only insert whitespace, never change, reorder or drop characters.

```ts
import { Chunker, IntlSegmenterAdapter } from "pg-hybrid-rag";

const segmenter = new IntlSegmenterAdapter({ languages: ["th"] });
const thaiChunker = new Chunker({ tokenLimit: 512, segmenter });
const thaiChunks = await thaiChunker.chunkSegmented(text, { language: "th" });
```

`IntlSegmenterAdapter` is described on [Utilities](/reference/utilities#intlsegmenteradapter).

## Overlap

Overlap repeats the end of one chunk at the start of the next.

- `chunk()` takes the last `overlap` characters of the emitted chunk and drops everything up to and including the first space, so the overlap starts on a word boundary. If that tail has no space, the whole tail is used. A leading orphaned low surrogate or combining mark is removed first.
- No overlap is produced when the emitted chunk is not longer than `overlap`.
- At the paragraph and sentence levels the overlap is joined to the following text with a space. Between fixed-size slices it is concatenated directly.
- When the paragraph after a flush is itself too long and is split into sentences, the overlap from the flushed buffer is not carried into it.
- `chunkSegmented()` uses whole segmenter words as overlap inside a long paragraph, and no overlap across paragraph boundaries.

## prefixFn

`prefixFn` is called once per `chunk()` or `chunkSegmented()` call that produces at least one chunk, with the `metadata` argument. If it returns a non-empty string, that label and a space are prepended to every chunk, except chunks whose content already starts with the label. Return `undefined` or `""` to skip.

```ts
import { Chunker } from "pg-hybrid-rag";

const chunker = new Chunker({
  tokenLimit: 512,
  prefixFn: (metadata) => (metadata.title ? `[${metadata.title}]` : undefined),
});

const chunks = chunker.chunk(text, { language: "en", title: "Billing FAQ" });
// chunks[0].content starts with "[Billing FAQ] "
```

The label is added after sizing and does not count toward the limit, so a long label makes every chunk that much longer than the limit.

## Size guarantees

- Every chunk boundary falls between grapheme clusters: a base character keeps its combining marks, and a surrogate pair is never split.
- No delimiter-free text is emitted uncapped: the fixed-size fallback (or, in `chunkSegmented()`, the grapheme split of an oversized word) always applies.
- At the paragraph and sentence levels the limit is a soft target. A buffer plus the prepended overlap, or plus a `prefixFn` label, can exceed the limit slightly. Leave headroom below your embedder's maximum input length.
- `chunk()` is synchronous and does not call the segmenter.

## Related

- [RagIndexer](/reference/rag-indexer)
- [Index documents](/how-to/index-documents)
- [CJK and word segmentation](/how-to/cjk-and-segmentation)
- [Languages](/reference/languages)
