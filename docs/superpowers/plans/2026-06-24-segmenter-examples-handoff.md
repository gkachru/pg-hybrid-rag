# Hand-off: add Segmenter / Thai examples to `examples/`

**Date:** 2026-06-24
**Status:** Ready to execute in a fresh session. Self-contained — no prior conversation needed.
**Branch to create:** `feat/segmenter-examples` off `main`.

---

## 1. Why this exists

The injectable **`Segmenter`** seam + **Thai** support feature was just designed, built, reviewed, and **merged to `main`** (16 commits; spec + plan + 12 implementation commits + merge). The implementation is complete and the full gate is green (`bun run typecheck` clean, `bun run lint` clean, `bun test` 360 pass, `bun run build` OK).

**What was NOT done:** the `examples/` directory was never updated — it was out of the original plan's scope (Task 10 was README-only). This hand-off closes that gap by adding Segmenter/Thai usage to all four example files so consumers can see the wiring.

Reference docs already in the repo (read for context if useful):
- Spec: `docs/superpowers/specs/2026-06-24-injectable-segmenter-design.md`
- Plan: `docs/superpowers/plans/2026-06-24-injectable-segmenter-thai.md`
- README "Word segmentation (Thai/CJK)" section (added in the feature) — mirror its wording/claims.

## 2. The shipped API (exact surface — all exported from `pg-hybrid-rag` / `src/index.ts`)

```ts
// Interface
interface Segmenter {
  segment(text: string, language: string): string | Promise<string>; // space-insertion only; passthrough for unhandled langs
  segmentsLanguage(language: string): boolean;                        // routing only; used by PostgresRagDatabase
}

// Zero-dep reference adapter (stdlib Intl.Segmenter; Node + Bun)
new IntlSegmenterAdapter({ languages: string[] }); // e.g. ["th"]  — segments only listed langs, passes others through

// Providers that now accept an optional `segmenter?: Segmenter` (pass the SAME instance to all three)
new RagPipeline({ tenantId, db, embedder, segmenter, ... });
new RagIndexer({ tenantId, db, embedder, segmenter, ... });
new PostgresRagDatabase(txProvider, { segmenter, /* cjk?, fts?, ivfflatProbes?, manageTransaction? */ });

// Chunker: new async method for whitespace-less scripts
new Chunker({ tokenLimit: 512, overlap: 75, segmenter });
await chunker.chunkSegmented(text, { language: "th" }); // Promise<Chunk[]>; emits NATURAL text, word-aware boundaries
chunker.chunk(text, metadata);                          // sync, UNCHANGED — still valid for spaced languages
```

**Behavior facts to encode in the examples (and keep accurate):**
- The segmenter feeds the **lexical legs only** — the dense embedding + reranker always see natural (unsegmented) text. (No example needs to do anything special for this; it's internal.)
- `IntlSegmenterAdapter` **passes through** any language not in its `languages` list, so injecting it globally is safe for an English/multilingual corpus.
- `chunkSegmented` **falls back to `chunk()`** when there's no segmenter or the language isn't handled, so it's always safe to call.
- **CAVEAT (must appear in comments):** `IntlSegmenterAdapter`'s Thai quality is ICU-dictionary-dependent and **weak on loanwords on both Node and Bun** — it's a runnable reference, not production-grade. For production Thai, inject a dictionary (PyThaiNLP-newmm) / ML (deepcut/attacut) / HTTP segmenter.
- Recommended Thai search config: lower `vectorMinScore` (the `0.8` default is e5-calibrated and kills the dense leg for BGE-M3-class models) + enable `rerank: true`.

## 3. Constraints (READ — these differ from the core library)

- **Biome lints `examples/`.** `biome.json` `files.includes` is `["**", ...]` (only node_modules/dist/json excluded). So new example code **must be lint-clean**: 2-space indent, lineWidth 100, organized imports. Run `bun run lint:fix` then `bun run lint`.
- **`tsc --noEmit` does NOT cover `examples/`** (tsconfig `exclude` includes `examples`). So `bun run typecheck` will NOT catch type errors in examples — be careful with types by hand. The editor/LSP will still flag them; trust lint + careful reading.
- **The NestJS examples import from the package name `"pg-hybrid-rag"`** (illustrative; not executed). **The playground imports from `../src/index.js`** and IS runnable, but needs live infra (Postgres + embedding API) — see `examples/.env.example` and `CLAUDE.md` "Playground setup". You likely cannot run it without that infra; if so, lint + a careful read is the bar, and say so in your report.
- Zero runtime deps; match each file's existing style and comment density.

## 4. Per-file tasks (concrete)

### 4a. `examples/nestjs-rag-module.ts` — wire one segmenter into all three providers

- Add `IntlSegmenterAdapter` to the `pg-hybrid-rag` import (keep imports organized/alphabetical for biome).
- In `createRagModule`, construct one segmenter and inject it into `db`, `pipeline`, and `indexer`:

```ts
  // Optional word segmenter for whitespace-less scripts (Thai/CJK). Inject the SAME instance
  // into db + pipeline + indexer so indexing, querying, and keyword-leg routing stay consistent.
  // IntlSegmenterAdapter is a zero-dependency reference (stdlib Intl.Segmenter) — its Thai quality
  // is weak on loanwords; for production Thai inject a dictionary/ML/HTTP segmenter. It passes
  // through any language not listed, so it is safe alongside an English/multilingual corpus.
  const segmenter = new IntlSegmenterAdapter({ languages: ["th"] });

  const db = new PostgresRagDatabase(txProvider, { segmenter });
  // ... existing stopWords/synonyms/logger ...
  const pipeline = new RagPipeline({ tenantId: TENANT_ID, db, embedder, stopWords, synonyms, logger, segmenter });
  const indexer = new RagIndexer({ tenantId: TENANT_ID, db, embedder, logger, segmenter });
```

- Add `segmenter` to the returned object (`return { pipeline, indexer, stopWords, synonyms, runMigrations, segmenter };`) so the reindex worker can reuse it.
- Update the bottom `// --- Usage ---` comment block to show indexing Thai with `chunkSegmented`:

```ts
// // Index a Thai document — chunkSegmented (async) gives word-aware boundaries; emitted chunk
// // text stays natural. Pass the module's segmenter into the Chunker too.
// const chunker = new Chunker({ tokenLimit: 512, overlap: 75, segmenter: rag.segmenter });
// const thChunks = await chunker.chunkSegmented(thaiText, { language: "th" });
// await rag.indexer.index("faq", faqId, thChunks, "th");
```

### 4b. `examples/nestjs-bullmq-reindex.ts` — use `chunkSegmented` in the worker

- Add `IntlSegmenterAdapter` to the import.
- Construct the segmenter, inject into `db`, `chunker`, and `indexer`; switch the chunk call to the async `chunkSegmented` (safe for all languages — it falls back to `chunk()`):

```ts
  const segmenter = new IntlSegmenterAdapter({ languages: ["th"] });
  const db = new PostgresRagDatabase(txProvider, { segmenter });
  const chunker = new Chunker({ tokenLimit: 512, overlap: 75, segmenter });
  const indexer = new RagIndexer({ tenantId: "default", db, embedder, segmenter, logger: deps.logger });

  return async (job: ReindexJob): Promise<number> => {
    // chunkSegmented = word-aware boundaries for whitespace-less scripts (Thai/CJK);
    // for spaced languages it transparently falls back to chunk().
    const chunks = await chunker.chunkSegmented(job.content, { ...job.metadata, language: job.language });
    return indexer.index(job.sourceType, job.sourceId, chunks, job.language);
  };
```

### 4c. `examples/nestjs-search.ts` — add a Thai search method + usage

- In the `search()` JSDoc language list, add a `"th"` line: `// - "th" → simple FTS + Segmenter-driven word boundaries on the lexical legs`.
- Add a method to `SearchService`:

```ts
  /**
   * Thai search. Thai has no word spaces, so a Segmenter (wired into the pipeline/indexer/db)
   * feeds word tokens to the lexical legs. The dense embedding carries most of the recall, so
   * lower vectorMinScore for a multilingual embedder (e.g. BGE-M3) and enable reranking.
   */
  async searchThai(query: string): Promise<RagResult[]> {
    return this.pipeline.search(query, {
      language: "th",
      topK: 10,
      vectorMinScore: 0.4, // 0.8 default is e5-calibrated; lower for BGE-M3-class models
      rerank: true,
    });
  }
```

- In the `// --- Usage ---` block add: `// const thResults = await search.searchThai("ราคาแพ็กเกจอินเทอร์เน็ต");`

### 4d. `examples/playground.ts` — index + query Thai end-to-end

- Add `IntlSegmenterAdapter` to the `../src/index.js` import (keep organized).
- After `const normalizer = new LanguageNormalizer();`, add:
  ```ts
  // Word segmenter for Thai (no inter-word spaces). Reference adapter — weak on Thai loanwords;
  // swap in PyThaiNLP/ML for real quality. Passes through non-Thai languages, so zh/ja keep using --cjk.
  const segmenter = new IntlSegmenterAdapter({ languages: ["th"] });
  ```
- Add Thai sample data near the other language blocks (concrete starter content — refine the Thai wording if you read Thai; it only needs to be plausible e-commerce text):

```ts
// ── Thai products & FAQs (no inter-word spaces → needs a Segmenter) ──
const PRODUCTS_TH = [
  {
    id: "00000000-0000-0000-0000-000000000061",
    name: "หูฟังไร้สายรุ่น Pro",
    brand: "Soundcore",
    text: `หูฟังไร้สายรุ่น Pro แบตเตอรี่ใช้งานได้ 40 ชั่วโมง ตัดเสียงรบกวนแบบแอ็กทีฟ กันน้ำระดับ IPX5 เชื่อมต่อบลูทูธ 5.3 ราคา 2,990 บาท รับประกัน 1 ปี สีดำ สีขาว และสีน้ำเงิน`,
  },
];
const FAQ_TH = [
  {
    id: "00000000-0000-0000-0000-f00000000061",
    text: `นโยบายการคืนสินค้าเป็นอย่างไร? คุณสามารถคืนสินค้าที่ยังไม่ได้ใช้งานได้ภายใน 14 วันหลังจากได้รับสินค้า สินค้าต้องอยู่ในบรรจุภัณฑ์เดิม การคืนเงินจะดำเนินการภายใน 5-7 วันทำการ`,
  },
];
```

- In `allProducts` add `...PRODUCTS_TH.map((p) => ({ ...p, lang: "th" })),` and in `allFaqs` add `...FAQ_TH.map((f) => ({ ...f, lang: "th" })),`.
- Inject the segmenter into the `db`, `indexer`, and `pipeline` constructors (add `segmenter,` to each options/config object — alongside the existing `normalizer`, etc.).
- Change the two `chunker.chunk(...)` calls (product loop ~line 560, FAQ loop ~line 581) to `await chunker.chunkSegmented(...)` (the loops are already `async`/`await indexer.index`, so awaiting is fine; non-Thai falls back to `chunk()`).
- Add Thai queries to the `queries` array (caption that quality depends on the segmenter):
```ts
      // Thai (no word spaces — Segmenter drives the lexical legs)
      { q: "หูฟังไร้สายกันน้ำ", lang: "th", desc: "TH product search" },
      { q: "นโยบายการคืนสินค้า", lang: "th", desc: "TH FAQ" },
```
- (Optional, for consistency) add a small `th` stop-word list to `seedStopWords` and a `th` synonym or two to `seedSynonyms`. Skip if it complicates things — not required.

## 5. Verification

Run from repo root:
- `bun run lint:fix && bun run lint` — **must be clean** (examples are linted). This is the primary gate.
- `bun run typecheck` — must stay clean (it won't check examples, but confirms you didn't break `src`).
- `bun test` — must stay green (you shouldn't be touching `src`/`tests`; confirm anyway).
- Playground live run (`bun run examples/playground.ts`) **only if** you have Postgres + an embedding API configured (`examples/.env`). If not, state in your report that the playground was lint-checked + read-verified but not executed for lack of infra. Do NOT block on infra you don't have.
- Sanity-read each NestJS example to confirm the snippets are internally consistent (they are not executed).

## 6. Finishing

- Work on `feat/segmenter-examples` off `main`. One commit per file or a single `docs(examples): …` commit is fine.
- Commit message convention in this repo ends with the Co-Authored-By / Claude-Session trailers (see recent `git log`).
- When done, use the **finishing-a-development-branch** skill: verify tests, then offer merge/PR/keep/discard.

## 7. Out of scope / do not do

- Do not modify `src/` or `tests/` (the feature is merged and reviewed). If you find a real bug in `src` while writing examples, report it — don't silently fix it here.
- Do not bundle a real Thai segmenter or add any npm dependency.
- Do not change the existing non-Thai playground behavior (zh/ja stay on the `--cjk` pg_bigm path; the `th`-only segmenter doesn't touch them).
