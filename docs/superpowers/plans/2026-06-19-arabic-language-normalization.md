# Arabic Language Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Arabic retrieval support to the hybrid RAG library via a library-owned, per-language orthographic normalizer applied symmetrically to indexed content and queries, plus Postgres `arabic` Snowball FTS and a configurable embedding dimension.

**Architecture:** A pure-TS `LanguageNormalizer` (Arabic ruleset; behind an injectable `Normalizer` interface) folds orthographic variants. `RagIndexer` stores the normalized form in a new `content_normalized` column (app-populated, exactly like `embedding`); `RagPipeline` normalizes the lexical query. The pg_trgm keyword leg and the tsvector trigger read `content_normalized`; the dense-vector leg and reranker keep raw text. The external CAMeL/Farasa service is a future drop-in implementation of the same `Normalizer` interface (not built here).

**Tech Stack:** TypeScript (strict), Bun + `bun:test`, Biome, PostgreSQL (pgvector, pg_trgm, built-in `arabic` Snowball FTS config).

## Global Constraints

- **Zero runtime dependencies.** No new npm deps. Normalization is pure TS (regex + `String.prototype.normalize`).
- **Library owns no I/O.** All providers injected at construction.
- **All SQL parameterized** — never interpolate user input. (GUC/index/column names are trusted constants.)
- **Strict TypeScript, no `any`.** (Test mocks may use `any` with a `biome-ignore` comment, matching existing tests.)
- **Linter: Biome** (`bun run lint`). **Tests: `bun:test`**, no real DB in unit tests (SQL behavior validated in the playground).
- **Exports barrel:** every new public symbol is re-exported from `src/index.ts`.
- **Dense-vector leg stays raw↔raw** — orthographic normalization feeds only the lexical legs (pg_trgm + tsvector), never the embedding or reranker.
- **`content_normalized` defaults to identity** when no `Normalizer` is injected, so non-Arabic behavior is unchanged.
- **Folding flags:** alef-maqsura (ى→ي) and taa-marbuta (ة→ه) folding default **on** but are individually disableable; hamza-carrier folding is **off**.
- **Commands:** `bun test <file>`, `bun run typecheck`, `bun run lint`.

---

### Task 1: `Normalizer` interface + `LanguageNormalizer` (Arabic ruleset)

**Files:**
- Modify: `src/interfaces.ts` (add `Normalizer` interface)
- Create: `src/normalize.ts`
- Create: `tests/normalize.test.ts`
- Modify: `src/index.ts` (exports)

**Interfaces:**
- Produces: `interface Normalizer { normalize(text: string, language: string): string | Promise<string> }`; `function normalizeForLanguage(text: string, language: string, opts?: ArabicNormalizeOptions): string`; `class LanguageNormalizer implements Normalizer`; `interface ArabicNormalizeOptions { foldAlefMaqsura?: boolean; foldTaaMarbuta?: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `tests/normalize.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { LanguageNormalizer, normalizeForLanguage } from "../src/normalize.js";

describe("normalizeForLanguage (Arabic)", () => {
  it("strips tashkeel/diacritics", () => {
    expect(normalizeForLanguage("العِطْر", "ar")).toBe("العطر");
  });
  it("folds alef variants to bare alef", () => {
    expect(normalizeForLanguage("أحمد إإآ", "ar")).toBe("احمد ااا");
  });
  it("folds alef-maqsura to yeh by default", () => {
    expect(normalizeForLanguage("مصطفى", "ar")).toBe("مصطفي");
  });
  it("folds taa-marbuta to heh by default", () => {
    expect(normalizeForLanguage("مكتبة", "ar")).toBe("مكتبه");
  });
  it("strips tatweel/kashida", () => {
    expect(normalizeForLanguage("كــتــاب", "ar")).toBe("كتاب");
  });
  it("folds Arabic-Indic and extended digits to ASCII", () => {
    expect(normalizeForLanguage("٣٥٠ ۹", "ar")).toBe("350 9");
  });
  it("is idempotent", () => {
    const once = normalizeForLanguage("الأسْعار ٣٥٠", "ar");
    expect(normalizeForLanguage(once, "ar")).toBe(once);
  });
  it("respects locale subtags (ar-SA)", () => {
    expect(normalizeForLanguage("مكتبة", "ar-SA")).toBe("مكتبه");
  });
  it("can disable taa-marbuta and alef-maqsura folding", () => {
    expect(normalizeForLanguage("مكتبة مصطفى", "ar", {
      foldTaaMarbuta: false,
      foldAlefMaqsura: false,
    })).toBe("مكتبة مصطفى");
  });
  it("does NOT fold when language is not Arabic (gating)", () => {
    // Arabic text tagged 'en' is left alone (NFC only) — folding is language-gated.
    expect(normalizeForLanguage("مكتبة", "en")).toBe("مكتبة");
  });
  it("leaves Latin text unchanged (NFC passthrough)", () => {
    expect(normalizeForLanguage("Café", "en")).toBe("Café".normalize("NFC"));
  });
});

describe("LanguageNormalizer", () => {
  it("implements Normalizer and applies the Arabic ruleset", () => {
    const n = new LanguageNormalizer();
    expect(n.normalize("الْعِطْر", "ar")).toBe("العطر");
  });
  it("forwards options", () => {
    const n = new LanguageNormalizer({ foldTaaMarbuta: false });
    expect(n.normalize("مكتبة", "ar")).toBe("مكتبة");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/normalize.test.ts`
Expected: FAIL — `Cannot find module "../src/normalize.js"`.

- [ ] **Step 3: Add the `Normalizer` interface**

In `src/interfaces.ts`, append after the `RerankerProvider` interface:

```ts
/**
 * Lexical text normalization, applied symmetrically to indexed content and the lexical query.
 * Orthographic folding now (pure TS); a future external CAMeL/Farasa service is a drop-in impl.
 * Async-capable so an HTTP-backed implementation needs no other code changes.
 *
 * NOTE: distinct from the per-search `RagSearchOptions.normalizer` (a synchronous semantic
 * query-rewriter that also feeds the embedding). This provider feeds the LEXICAL legs only.
 */
export interface Normalizer {
  normalize(text: string, language: string): string | Promise<string>;
}
```

- [ ] **Step 4: Implement `src/normalize.ts`**

```ts
import type { Normalizer } from "./interfaces.js";

// Tashkeel/harakat (U+064B–U+065F) + superscript alef (U+0670).
const TASHKEEL = /[ً-ٰٟ]/g;
// Tatweel/kashida (U+0640), ZWNJ (U+200C), ZWJ (U+200D).
const TATWEEL_ZW = /[ـ‌‍]/g;
// Alef variants: madda (آ), hamza-above (أ), hamza-below (إ), wasla (ٱ) → bare alef (ا).
const ALEF = /[آأإٱ]/g;
const ALEF_BARE = "ا";
const ALEF_MAQSURA = /ى/g; // ى → ي
const YEH = "ي";
const TAA_MARBUTA = /ة/g; // ة → ه
const HEH = "ه";
const ARABIC_INDIC = /[٠-٩]/g; // ٠-٩
const EXT_ARABIC_INDIC = /[۰-۹]/g; // ۰-۹ (Persian/Urdu forms)

export interface ArabicNormalizeOptions {
  /** Fold alef-maqsura ى → yeh ي. Default: true. */
  foldAlefMaqsura?: boolean;
  /** Fold taa-marbuta ة → heh ه. Default: true. */
  foldTaaMarbuta?: boolean;
}

function normalizeArabic(text: string, opts: ArabicNormalizeOptions): string {
  let s = text.normalize("NFC");
  s = s.replace(TASHKEEL, "").replace(TATWEEL_ZW, "");
  s = s.replace(ALEF, ALEF_BARE);
  if (opts.foldAlefMaqsura !== false) s = s.replace(ALEF_MAQSURA, YEH);
  if (opts.foldTaaMarbuta !== false) s = s.replace(TAA_MARBUTA, HEH);
  s = s.replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(EXT_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0));
  return s.normalize("NFC");
}

/**
 * Per-language orthographic normalization. Language-gated and idempotent.
 * Arabic (`ar`) applies the ruleset above; every other language is NFC-only
 * (the seam is generic — other rulesets are documented future extension points).
 */
export function normalizeForLanguage(
  text: string,
  language: string,
  opts: ArabicNormalizeOptions = {},
): string {
  const base = (language ?? "").split("-")[0].toLowerCase();
  if (base === "ar") return normalizeArabic(text, opts);
  return text.normalize("NFC");
}

/** Default pure-TS `Normalizer`. Holds the Arabic folding flags. */
export class LanguageNormalizer implements Normalizer {
  private opts: ArabicNormalizeOptions;
  constructor(opts: ArabicNormalizeOptions = {}) {
    this.opts = opts;
  }
  normalize(text: string, language: string): string {
    return normalizeForLanguage(text, language, this.opts);
  }
}
```

- [ ] **Step 5: Export from the barrel**

In `src/index.ts`, add to the interfaces type export block the name `Normalizer`, and add a new export line near the other `src/*` exports:

```ts
export { LanguageNormalizer, normalizeForLanguage } from "./normalize.js";
export type { ArabicNormalizeOptions } from "./normalize.js";
```

Add `Normalizer` to the existing `export type { ... } from "./interfaces.js";` list (keep the list alphabetized: it goes after `FtsStrategy`).

- [ ] **Step 6: Run tests + typecheck + lint**

Run: `bun test tests/normalize.test.ts && bun run typecheck && bun run lint`
Expected: PASS; typecheck clean; lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/normalize.ts src/interfaces.ts src/index.ts tests/normalize.test.ts
git commit -m "feat: add library-owned Arabic orthographic normalizer + Normalizer interface"
```

---

### Task 2: Thread `content_normalized` through the DB write path

**Files:**
- Modify: `src/interfaces.ts` (`RagDatabase.insertChunks` + `replaceSource` chunk shapes)
- Modify: `src/adapters/PostgresRagDatabase.ts` (`buildInsert`, `insertChunks`, `replaceSource` chunk shapes)
- Modify: `tests/postgresRagDatabase.test.ts` (insertChunks/replaceSource fixtures + assertions)

**Interfaces:**
- Consumes: nothing new.
- Produces: the chunk-row object accepted by `insertChunks`/`replaceSource`/`buildInsert` now includes `contentNormalized: string`. INSERT column list becomes `(tenant_id, source_type, source_id, chunk_index, content, language, embedding, metadata, content_normalized)` — `content_normalized` is the **9th** column (appended last; `embedding` stays at `$7::vector`).

- [ ] **Step 1: Update the write-path tests to expect `content_normalized` (failing)**

In `tests/postgresRagDatabase.test.ts`, in `describe("PostgresRagDatabase.insertChunks")`, replace the `chunk` fixture and the three assertions:

```ts
  const chunk = {
    sourceType: "faq",
    sourceId: "doc-1",
    chunkIndex: "0",
    content: "hello world",
    contentNormalized: "hello world",
    language: "en",
    embedding: [0.1, 0.2, 0.3],
    metadata: '{"k":"v"}',
  };
```

Update the column-list assertion:

```ts
    expect(calls[0].sql).toContain(
      "INSERT INTO rag_documents (tenant_id, source_type, source_id, chunk_index, content, language, embedding, metadata, content_normalized)",
    );
```

Update the per-chunk params assertion (now 9 values, content_normalized last; embedding still `$7`):

```ts
    expect(calls[0].params).toEqual([
      "t1",
      "faq",
      "doc-1",
      "0",
      "hello world",
      "en",
      "[0.1,0.2,0.3]",
      '{"k":"v"}',
      "hello world",
    ]);
    expect(calls[0].sql).toContain("$7::vector");
```

Update the batch test (`second` fixture gets `contentNormalized`, 18 params, 2nd embedding at `$16`):

```ts
    const second = {
      ...chunk,
      sourceId: "doc-2",
      chunkIndex: "1",
      embedding: [0.4, 0.5, 0.6],
    };
    await new PostgresRagDatabase(txProvider).insertChunks("t1", [chunk, second]);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toHaveLength(18); // 9 per chunk
    expect(calls[0].params?.[15]).toBe("[0.4,0.5,0.6]"); // 2nd row embedding ($16)
    expect(calls[0].sql).toContain("$7::vector");
    expect(calls[0].sql).toContain("$16::vector");
    const refs = referencedPlaceholders(calls[0].sql);
    for (let n = 1; n <= 18; n++) expect(refs.has(n)).toBe(true);
    for (const ref of refs) expect(ref).toBeLessThanOrEqual(18);
```

In `describe("PostgresRagDatabase.replaceSource")`, add `contentNormalized: "hi"` to its `chunk` fixture:

```ts
  const chunk = {
    sourceType: "faq",
    sourceId: "doc-1",
    chunkIndex: "0",
    content: "hi",
    contentNormalized: "hi",
    language: "en",
    embedding: [0.1, 0.2, 0.3],
    metadata: '{"k":"v"}',
  };
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/postgresRagDatabase.test.ts`
Expected: FAIL — the INSERT still lists 8 columns / binds 8 params per chunk.

- [ ] **Step 3: Add `contentNormalized` to the interface chunk shapes**

In `src/interfaces.ts`, in BOTH `insertChunks` and `replaceSource` on `RagDatabase`, add `contentNormalized: string;` to the chunk array element type (place it right after `content: string;`):

```ts
    chunks: Array<{
      sourceType: string;
      sourceId: string;
      chunkIndex: string;
      content: string;
      contentNormalized: string;
      language: string;
      embedding: number[];
      metadata: string;
    }>,
```

- [ ] **Step 4: Update `PostgresRagDatabase` chunk shapes + `buildInsert`**

In `src/adapters/PostgresRagDatabase.ts`, add `contentNormalized: string;` (after `content: string;`) to the chunk array type in `buildInsert`, `insertChunks`, and `replaceSource` (three identical edits).

In `buildInsert`, update the `params.push(...)` and `valueClauses.push(...)` and the SQL:

```ts
      params.push(
        tenantId,
        chunk.sourceType,
        chunk.sourceId,
        chunk.chunkIndex,
        chunk.content,
        chunk.language,
        embeddingStr,
        chunk.metadata,
        chunk.contentNormalized,
      );
      valueClauses.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::vector, $${offset + 8}, $${offset + 9})`,
      );
```

```ts
      sql: `INSERT INTO rag_documents (tenant_id, source_type, source_id, chunk_index, content, language, embedding, metadata, content_normalized)
         VALUES ${valueClauses.join(", ")}`,
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test tests/postgresRagDatabase.test.ts && bun run typecheck`
Expected: PASS. (Typecheck will FAIL in `RagIndexer.ts` until Task 3 — that's expected; if running typecheck now, note the only error is `contentNormalized` missing in `RagIndexer`. Proceed to Task 3.)

- [ ] **Step 6: Commit**

```bash
git add src/interfaces.ts src/adapters/PostgresRagDatabase.ts tests/postgresRagDatabase.test.ts
git commit -m "feat: add content_normalized column to the batch INSERT write path"
```

---

### Task 3: `RagIndexer` computes `content_normalized` via an injected `Normalizer`

**Files:**
- Modify: `src/RagIndexer.ts`
- Modify: `tests/indexer.test.ts`

**Interfaces:**
- Consumes: `Normalizer` (Task 1); the `contentNormalized` field on the write path (Task 2).
- Produces: `RagIndexerConfig` gains `normalizer?: Normalizer`. When set, `content_normalized = await normalizer.normalize(chunk.content, language)`; when unset, `content_normalized = chunk.content` (identity).

- [ ] **Step 1: Write the failing test**

In `tests/indexer.test.ts`, add inside `describe("RagIndexer")`:

```ts
  it("computes content_normalized via the injected normalizer", async () => {
    capturedInsertChunks = [];
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db: mockDb,
      embedder: mockEmbedder,
      normalizer: { normalize: (t: string) => `N:${t}` },
    });
    await indexer.index("faq", "f-1", [{ index: 0, content: "raw", metadata: {} }], "ar");
    const rows = capturedInsertChunks as Array<Record<string, unknown>>;
    expect(rows[0].content).toBe("raw"); // raw preserved
    expect(rows[0].contentNormalized).toBe("N:raw"); // normalized stored separately
  });

  it("defaults content_normalized to raw content when no normalizer is injected", async () => {
    capturedInsertChunks = [];
    const indexer = new RagIndexer({ tenantId: "t-1", db: mockDb, embedder: mockEmbedder });
    await indexer.index("faq", "f-1", [{ index: 0, content: "raw", metadata: {} }], "en");
    const rows = capturedInsertChunks as Array<Record<string, unknown>>;
    expect(rows[0].contentNormalized).toBe("raw");
  });

  it("awaits an async normalizer (external-service shape)", async () => {
    capturedInsertChunks = [];
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db: mockDb,
      embedder: mockEmbedder,
      normalizer: { normalize: async (t: string) => `A:${t}` },
    });
    await indexer.index("faq", "f-1", [{ index: 0, content: "raw", metadata: {} }], "ar");
    const rows = capturedInsertChunks as Array<Record<string, unknown>>;
    expect(rows[0].contentNormalized).toBe("A:raw");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/indexer.test.ts`
Expected: FAIL — `normalizer` is not a valid `RagIndexerConfig` field / `contentNormalized` undefined.

- [ ] **Step 3: Implement**

In `src/RagIndexer.ts`, import the type and extend config + class:

```ts
import type { EmbeddingProvider, Normalizer, RagDatabase, RagLogger } from "./interfaces.js";
```

```ts
export interface RagIndexerConfig {
  tenantId: string;
  db: RagDatabase;
  embedder: EmbeddingProvider;
  /** Optional lexical normalizer; applied to content for the `content_normalized` column. */
  normalizer?: Normalizer;
  logger?: RagLogger;
}
```

Add a private field and assign it in the constructor:

```ts
  private normalizer?: Normalizer;
```
```ts
    this.normalizer = config.normalizer;
```

In `index()`, replace the `values` construction with a normalized form (note it becomes an `await`/`Promise.all`):

```ts
    // Build the chunk rows. content stays raw (display + dense embedding); content_normalized
    // feeds the lexical legs. Identity when no normalizer is injected (non-Arabic unaffected).
    const values = await Promise.all(
      chunks.map(async (chunk, i) => {
        const lang = chunk.metadata.language ?? language;
        const content = chunk.content;
        const contentNormalized = this.normalizer
          ? await this.normalizer.normalize(content, lang)
          : content;
        return {
          sourceType,
          sourceId,
          chunkIndex: String(chunk.index),
          content,
          contentNormalized,
          language: lang,
          embedding: embeddings[i],
          metadata: JSON.stringify(chunk.metadata),
        };
      }),
    );
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `bun test tests/indexer.test.ts && bun run typecheck && bun run lint`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/RagIndexer.ts tests/indexer.test.ts
git commit -m "feat: RagIndexer populates content_normalized via injected Normalizer"
```

---

### Task 4: `RagPipeline` applies the `Normalizer` to the lexical query only

**Files:**
- Modify: `src/RagPipeline.ts`
- Modify: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `Normalizer` (Task 1).
- Produces: `RagPipelineConfig` gains `normalizer?: Normalizer`. The injected normalizer folds the lexical query (the `query` passed to `hybridSearch`) but NOT the embedding/reranker query.

- [ ] **Step 1: Write the failing test**

In `tests/pipeline.test.ts`, add inside `describe("RagPipeline")`:

```ts
  it("applies the injected normalizer to the lexical query but not the embedding", async () => {
    const pipelineWithNorm = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      // Uppercase stand-in for orthographic folding, so the effect is observable.
      normalizer: { normalize: (t: string) => t.toUpperCase() },
    });
    await pipelineWithNorm.search("alef test", { language: "ar" });
    // Lexical legs get the normalized query…
    expect(lastSearchParams.query).toBe("ALEF TEST");
    // …but the embedding sees the un-folded (natural) query.
    expect(mockEmbedQuery).toHaveBeenCalledWith("alef test");
  });

  it("awaits an async normalizer for the lexical query", async () => {
    const pipelineWithNorm = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      normalizer: { normalize: async (t: string) => `A:${t}` },
    });
    await pipelineWithNorm.search("hi", { language: "ar" });
    expect(lastSearchParams.query).toBe("A:hi");
  });

  it("no injected normalizer leaves the lexical query unchanged", async () => {
    await pipeline.search("plain query", { language: "en" });
    expect(lastSearchParams.query).toBe("plain query");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline.test.ts`
Expected: FAIL — `normalizer` not a valid `RagPipelineConfig` field; `lastSearchParams.query` not folded.

- [ ] **Step 3: Implement config + field**

In `src/RagPipeline.ts`, import `Normalizer` and add to config + class:

```ts
import type {
  EmbeddingProvider,
  Normalizer,
  RagDatabase,
  RagLogger,
  RagSpan,
  RagTracer,
  RerankerProvider,
  StopWordsProvider,
  SynonymProvider,
} from "./interfaces.js";
```

```ts
export interface RagPipelineConfig {
  tenantId: string;
  db: RagDatabase;
  embedder: EmbeddingProvider;
  /** Lexical normalizer applied to the keyword/FTS query (not the embedding). */
  normalizer?: Normalizer;
  stopWords?: StopWordsProvider;
  synonyms?: SynonymProvider;
  reranker?: RerankerProvider;
  logger?: RagLogger;
  tracer?: RagTracer;
}
```

Add the field + constructor assignment:

```ts
  private normalizer?: Normalizer;
```
```ts
    this.normalizer = config.normalizer;
```

- [ ] **Step 4: Apply orthographic normalization to the lexical query only**

In `search()`, the block currently reads:

```ts
        const naturalQuery = searchQuery;

        if (allStopWords.size > 0) {
          searchQuery = removeStopWords(searchQuery, allStopWords);
          if (!searchQuery.trim()) searchQuery = naturalQuery;
        }
        span.setAttribute("stopWordsApplied", searchQuery !== query);
```

Replace it with (introduces `lexicalQuery`; `naturalQuery` stays the embedding/reranker text):

```ts
        const naturalQuery = searchQuery;

        // Orthographic normalization for the LEXICAL legs only (never the embedding/reranker).
        let lexicalQuery = naturalQuery;
        if (this.normalizer) {
          const preOrtho = lexicalQuery;
          lexicalQuery = await this.normalizer.normalize(lexicalQuery, queryLanguage);
          // A folding normalizer never empties text, but guard anyway.
          if (!lexicalQuery.trim()) lexicalQuery = preOrtho;
          span.setAttribute("orthographicNormalizerApplied", true);
        }

        if (allStopWords.size > 0) {
          const preStop = lexicalQuery;
          lexicalQuery = removeStopWords(lexicalQuery, allStopWords);
          // Fall back to the normalized (pre-stop-word) form, not the raw query.
          if (!lexicalQuery.trim()) lexicalQuery = preStop;
        }
        span.setAttribute("stopWordsApplied", lexicalQuery !== query);
```

Then update the two remaining references to `searchQuery` that feed the DB/log to use `lexicalQuery`:
- In the `this.db.hybridSearch({ ... })` call: `query: searchQuery,` → `query: lexicalQuery,`
- In the final `this.logger.debug?.({ ..., query: searchQuery }, ...)` "Search returned 0 results" call: `query: searchQuery` → `query: lexicalQuery`.

(Leave `naturalQuery` feeding `embedQuery(naturalQuery)` and the reranker untouched.)

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `bun test tests/pipeline.test.ts && bun run typecheck && bun run lint`
Expected: PASS (the existing stop-word / normalizer-fallback tests stay green — without an injected normalizer, `lexicalQuery === naturalQuery`).

- [ ] **Step 6: Commit**

```bash
git add src/RagPipeline.ts tests/pipeline.test.ts
git commit -m "feat: RagPipeline normalizes the lexical query (not the embedding)"
```

---

### Task 5: pg_trgm keyword leg matches on `content_normalized`

**Files:**
- Modify: `src/adapters/PostgresRagDatabase.ts` (`buildTrigramKeywordSql`)
- Modify: `tests/postgresRagDatabase.test.ts` (keyword-leg + leg-failure assertions)

**Interfaces:**
- Consumes: the `content_normalized` column (created in Task 7's migration; unit tests mock the DB so no column is required to assert SQL shape).
- Produces: the trigram leg's WHERE/score/ORDER reference `content_normalized`; the SELECT still returns raw `content` for display.

- [ ] **Step 1: Update the keyword-leg tests (failing)**

In `tests/postgresRagDatabase.test.ts`, update these assertions:

`it("runs the keyword leg with word_similarity by default", ...)`:
```ts
    expect(calls.some((c) => c.sql.includes("word_similarity($2, content_normalized)"))).toBe(true);
```

`it("selects the chunk id in the vector and keyword legs (for RRF dedup)", ...)`:
```ts
    const keywordLeg = calls.find((c) => c.sql.includes("word_similarity($2, content_normalized)"));
```

`it("keyword leg uses the index-friendly word-similarity operator ($2 <% content)", ...)` — rewrite the body:
```ts
    const keywordLeg = calls.find((c) => c.sql.includes("word_similarity($2, content_normalized)"));
    // WHERE drives the GIN index on content_normalized via the operator.
    expect(keywordLeg?.sql).toContain("$2 <% content_normalized");
    expect(keywordLeg?.sql).not.toContain("word_similarity($2, content_normalized) >");
    expect(keywordLeg?.sql).toContain("word_similarity($2, content_normalized) as score");
    expect(keywordLeg?.sql).toContain("ORDER BY word_similarity($2, content_normalized) DESC");
    // The SELECT list still returns the raw content column for display.
    expect(keywordLeg?.sql).toContain("SELECT id, content,");
```

In the `failingKeywordTx` helper (top of `describe("PostgresRagDatabase.hybridSearch leg-failure handling")`), update the match string so the simulated failure still triggers:
```ts
        if (sql.includes("word_similarity($2, content_normalized) as score")) {
          throw new Error("keyword leg boom");
        }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/postgresRagDatabase.test.ts`
Expected: FAIL — leg still emits `word_similarity($2, content)`.

- [ ] **Step 3: Implement**

In `src/adapters/PostgresRagDatabase.ts`, in `buildTrigramKeywordSql`, change the SQL so the match/score use `content_normalized` (keep `content` in the SELECT list for display):

```ts
  const sql = `
          SELECT id, content, source_type, source_id, metadata,
                 word_similarity($2, content_normalized) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND $2 <% content_normalized
            ${f.clause}
          ORDER BY word_similarity($2, content_normalized) DESC
          LIMIT $3
        `;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/postgresRagDatabase.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/PostgresRagDatabase.ts tests/postgresRagDatabase.test.ts
git commit -m "feat: pg_trgm keyword leg matches on content_normalized"
```

---

### Task 6: Configurable embedding dimension

**Files:**
- Modify: `sql/002_rag_documents.sql`
- Modify: `src/migrate.ts` (`MigrateOptions` + templating)
- Modify: `tests/migrate.test.ts`

**Interfaces:**
- Produces: `MigrateOptions.embeddingDimensions?: number` (default 384). The runner replaces the literal token `__EMBEDDING_DIM__` in every migration file with this value before splitting statements.

- [ ] **Step 1: Write the failing test**

In `tests/migrate.test.ts`, add inside `describe("ragMigrate")`:

```ts
  it("defaults the embedding dimension to 384", async () => {
    const { client, executedQueries } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(executedQueries.some((q) => q.includes("vector(384)"))).toBe(true);
    expect(executedQueries.some((q) => q.includes("__EMBEDDING_DIM__"))).toBe(false);
  });

  it("substitutes a custom embedding dimension", async () => {
    const { client, executedQueries } = createMockClient();
    await ragMigrate(client, { sqlDir, embeddingDimensions: 1024 });
    expect(executedQueries.some((q) => q.includes("vector(1024)"))).toBe(true);
    expect(executedQueries.some((q) => q.includes("vector(384)"))).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/migrate.test.ts`
Expected: FAIL — `sql/002` still hardcodes `vector(384)`, and `embeddingDimensions` is not an option.

- [ ] **Step 3: Tokenize the schema**

In `sql/002_rag_documents.sql`, change the embedding column:

```sql
  embedding vector(__EMBEDDING_DIM__) NOT NULL,
```

- [ ] **Step 4: Add the option + substitution to the runner**

In `src/migrate.ts`, add to `MigrateOptions`:

```ts
  /**
   * Embedding vector dimension for the rag_documents.embedding column (migration 002).
   * Substituted for the `__EMBEDDING_DIM__` token. Default: 384. Only affects fresh installs —
   * changing this on an existing DB requires a manual ALTER + full re-embed.
   */
  embeddingDimensions?: number;
```

In `ragMigrate`, after `const sql = readFileSync(join(sqlDir, file), "utf-8");`, substitute the token before splitting:

```ts
    const sql = readFileSync(join(sqlDir, file), "utf-8").replaceAll(
      "__EMBEDDING_DIM__",
      String(options.embeddingDimensions ?? 384),
    );
```

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `bun test tests/migrate.test.ts && bun run typecheck && bun run lint`
Expected: PASS. Also run the full suite to confirm no migration test regressed: `bun test`.

- [ ] **Step 6: Commit**

```bash
git add sql/002_rag_documents.sql src/migrate.ts tests/migrate.test.ts
git commit -m "feat: make embedding dimension configurable via ragMigrate(embeddingDimensions)"
```

---

### Task 7: Migration 013 — `content_normalized` column + trigram index move

**Files:**
- Create: `sql/013_normalization.sql`
- Modify: `tests/migrate.test.ts`

**Interfaces:**
- Produces: the `content_normalized` column and the `idx_rag_content_normalized_trgm` GIN index.

- [ ] **Step 1: Write the failing test**

In `tests/migrate.test.ts`, add inside `describe("ragMigrate")`:

```ts
  it("applies the content_normalized migration (013) by default", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(appliedMigrations).toContain("013_normalization.sql");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/migrate.test.ts`
Expected: FAIL — no such migration file.

- [ ] **Step 3: Create the migration**

Create `sql/013_normalization.sql`:

```sql
-- content_normalized: app-populated orthographic-normalized text feeding the LEXICAL legs.
-- Plain nullable column (ADD is instant, metadata-only) — populated by RagIndexer, exactly like
-- the embedding column. Raw `content` is kept for display + dense embedding.
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS content_normalized TEXT;

-- Identity backfill for existing rows so the lexical legs keep working immediately. Arabic rows
-- only gain orthographic folding after they are re-indexed with a Normalizer.
UPDATE rag_documents SET content_normalized = content WHERE content_normalized IS NULL;

-- Move the pg_trgm GIN index onto the normalized column (the keyword leg now matches it).
-- NOTE: for large existing deployments, build this CONCURRENTLY out-of-band BEFORE running the
-- migration (CREATE INDEX CONCURRENTLY cannot run inside the migration's transaction); the
-- IF NOT EXISTS below then no-ops.
CREATE INDEX IF NOT EXISTS idx_rag_content_normalized_trgm
  ON rag_documents USING GIN (content_normalized gin_trgm_ops);

DROP INDEX IF EXISTS idx_rag_content_trgm;
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sql/013_normalization.sql tests/migrate.test.ts
git commit -m "feat: migration 013 — content_normalized column + trigram index move"
```

---

### Task 8: Migration 014 — `arabic` FTS config + tsvector trigger reads `content_normalized`

**Files:**
- Create: `sql/014_arabic_fts.sql`
- Modify: `tests/migrate.test.ts`

**Interfaces:**
- Produces: `rag_fts_config('ar') = 'arabic'`; the tsvector trigger builds from `COALESCE(content_normalized, content)`.

- [ ] **Step 1: Write the failing test**

In `tests/migrate.test.ts`, add inside `describe("ragMigrate")`:

```ts
  it("applies the Arabic FTS migration (014) by default", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(appliedMigrations).toContain("014_arabic_fts.sql");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/migrate.test.ts`
Expected: FAIL — no such migration file.

- [ ] **Step 3: Create the migration**

Create `sql/014_arabic_fts.sql` (re-declares `rag_fts_config` with the `arabic` case added, updates the trigger to read the normalized column, and backfills):

```sql
-- Add Arabic to the FTS config map (Postgres ships a built-in 'arabic' Snowball config, PG12+).
CREATE OR REPLACE FUNCTION rag_fts_config(lang TEXT) RETURNS regconfig AS $$
BEGIN
  RETURN CASE
    WHEN lang IN ('en', 'en-US', 'en-IN') THEN 'english'
    WHEN lang IN ('es', 'es-ES', 'es-MX') THEN 'spanish'
    WHEN lang IN ('fr', 'fr-FR')          THEN 'french'
    WHEN lang IN ('de', 'de-DE')          THEN 'german'
    WHEN lang IN ('it', 'it-IT')          THEN 'italian'
    WHEN lang IN ('pt', 'pt-PT')          THEN 'portuguese'
    WHEN lang IN ('ro', 'ro-RO')          THEN 'romanian'
    WHEN lang IN ('ar', 'ar-SA', 'ar-EG') THEN 'arabic'
    ELSE 'simple'
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Build the tsvector from the normalized text (orthographic fold → Snowball stemming).
-- COALESCE keeps the FTS leg safe if a row is ever written without a normalized form.
CREATE OR REPLACE FUNCTION rag_documents_tsvector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.content_tsvector := to_tsvector(
    rag_fts_config(NEW.language),
    COALESCE(NEW.content_normalized, NEW.content)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Backfill every row's tsvector under the new config + normalized source.
UPDATE rag_documents
SET content_tsvector = to_tsvector(
  rag_fts_config(language),
  COALESCE(content_normalized, content)
);
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/migrate.test.ts && bun test`
Expected: PASS (full suite green).

- [ ] **Step 5: Commit**

```bash
git add sql/014_arabic_fts.sql tests/migrate.test.ts
git commit -m "feat: migration 014 — arabic FTS config + tsvector from content_normalized"
```

---

### Task 9: Normalize Arabic stop words at load

**Files:**
- Modify: `src/adapters/CachingStopWordsLoader.ts`
- Modify: `tests/cachingStopWordsLoader.test.ts`

**Interfaces:**
- Consumes: `normalizeForLanguage` (Task 1).
- Produces: `CachingStopWordsLoaderConfig.normalizeWord?: (word: string, language: string) => string`. When set, each stop word is normalized (after lowercasing) so it matches the normalized query tokens.

- [ ] **Step 1: Write the failing test**

In `tests/cachingStopWordsLoader.test.ts`, add a test (match the file's existing mock/loadFn style — it injects a `loadFn` returning `StopWordRow[]`):

```ts
import { normalizeForLanguage } from "../src/normalize.js";

it("normalizes stop words at load when normalizeWord is provided", async () => {
  const loader = new CachingStopWordsLoader({
    txProvider: { withConnection: async <T>(fn: (c: SqlClient) => Promise<T>) => fn({} as SqlClient) },
    loadFn: async () => [{ language: "ar", word: "الْعِطْر" }],
    normalizeWord: normalizeForLanguage,
  });
  const map = await loader.load("t-1");
  // Diacritics folded → matches the normalized query token "العطر".
  expect(map.get("ar")?.has("العطر")).toBe(true);
});
```

(If the file already imports `SqlClient`/`CachingStopWordsLoader`, reuse those imports; otherwise add `import type { SqlClient } from "../src/interfaces.js";`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cachingStopWordsLoader.test.ts`
Expected: FAIL — `normalizeWord` is not a config option.

- [ ] **Step 3: Implement**

In `src/adapters/CachingStopWordsLoader.ts`, extend config + apply at load:

```ts
export interface CachingStopWordsLoaderConfig {
  txProvider: TransactionProvider;
  /** Optional custom load function. Defaults to querying rag_stop_words. */
  loadFn?: (client: SqlClient, tenantId: string) => Promise<StopWordRow[]>;
  /** Optional per-language word normalizer (e.g. normalizeForLanguage) applied at load. */
  normalizeWord?: (word: string, language: string) => string;
}
```

Add a field + constructor assignment:

```ts
  private normalizeWord?: (word: string, language: string) => string;
```
```ts
    this.normalizeWord = config.normalizeWord;
```

In `load()`, change the map-building loop to normalize:

```ts
      const map = new Map<string, Set<string>>();
      for (const row of rows) {
        if (!map.has(row.language)) map.set(row.language, new Set());
        const lowered = row.word.toLowerCase();
        const word = this.normalizeWord ? this.normalizeWord(lowered, row.language) : lowered;
        map.get(row.language)?.add(word);
      }
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `bun test tests/cachingStopWordsLoader.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/CachingStopWordsLoader.ts tests/cachingStopWordsLoader.test.ts
git commit -m "feat: optionally normalize stop words at load (CachingStopWordsLoader)"
```

---

### Task 10: Wire the normalizer into the playground + Arabic regression samples

**Files:**
- Modify: `examples/playground.ts`

**Interfaces:**
- Consumes: `LanguageNormalizer` (Task 1), `normalizeForLanguage` (Task 1), `embeddingDimensions` (Task 6).

This task is validated by running the playground end-to-end against the local DB (per the "no real DB in unit tests" convention). It exercises the full Arabic path: normalized index column, `arabic` FTS, normalized lexical query.

- [ ] **Step 1: Import the normalizer**

In `examples/playground.ts`, add `LanguageNormalizer` and `normalizeForLanguage` to the existing import from `"../src/index.js"`.

- [ ] **Step 2: Construct one shared normalizer and inject it**

Near the embedder construction, add:

```ts
const normalizer = new LanguageNormalizer();
```

Pass `normalizer` into the `RagIndexer` config and the `RagPipeline` config (add `normalizer,` to both option objects). Pass `normalizeWord: normalizeForLanguage` into the `CachingStopWordsLoader` config.

- [ ] **Step 3: Add an Arabic normalization regression query**

In the `queries` array, add an entry that only matches if orthographic normalization is working — a diacritized / alternate-form variant of indexed Arabic text:

```ts
      { q: "سياسه الارجاع", lang: "ar", desc: "AR normalization (taa-marbuta + alef fold → matches 'سياسة الإرجاع')" },
```

- [ ] **Step 4: Run the playground**

Ensure infra is up (`cd examples && podman compose up -d`), then run:

Run: `bun run examples/playground.ts`
Expected: completes without error; the new `AR normalization` query returns the return-policy Arabic FAQ (it would miss before normalization because of the taa-marbuta/alef differences). Existing Arabic queries still return results.

- [ ] **Step 5: Commit**

```bash
git add examples/playground.ts
git commit -m "test: wire LanguageNormalizer into playground + add AR normalization query"
```

---

## Self-Review

**Spec coverage:**
- §1 normalizer framework → Task 1. §2 injectable `Normalizer` → Tasks 1, 3, 4. §3 symmetric application (dense raw, lexical normalized) → Tasks 3, 4, 5. §4 `content_normalized` column + index/trigger → Tasks 2, 5, 7, 8. §5 `arabic` FTS → Task 8. §6 configurable dimension → Task 6. §7 stop-word normalization → Task 9. §8 reranker (no code change; documented) → no task, intentionally. Playground/tests → Task 10. ✅
- Out of scope per spec (no task, intentional): external NLP service, segmentation/lemmatization, Arabizi, model swap, CJK width-folding, RRF retuning, other-language rulesets.

**Type consistency:** `Normalizer.normalize(text, language): string | Promise<string>` used identically in Tasks 1/3/4. `contentNormalized: string` added to the chunk shape in interfaces + adapter + indexer (Tasks 2/3). INSERT column order fixed: `content_normalized` is the 9th column, `embedding` stays `$7::vector` (Tasks 2 assertions and `buildInsert` agree). `idx_rag_content_normalized_trgm` (Task 7) is the GIN index the keyword leg's `$2 <% content_normalized` (Task 5) relies on.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every SQL migration is shown in full; every command has an expected result.

**Migration gating check:** `013_normalization.sql` and `014_arabic_fts.sql` contain none of the runner's optional keywords (`rls`/`cjk`/`vectorchord`/`textsearch`), so both apply by default. ✅

## Execution Handoff

Plan complete. Recommended: subagent-driven execution (fresh subagent per task, review between tasks).
