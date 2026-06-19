# Arabic dialectal RAG benchmark — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reproducible Arabic RAG retrieval benchmark over real banking + telecom help-center FAQ content (with T&C-PDF distractors), scoring retrieval quality across the library's flags and across MSA/Saudi/Darija dialects.

**Architecture:** A one-time **prep** phase (scrape FAQs → snapshot; extract PDFs; author dialect queries → frozen `queries.json`) produces gitignored corpus artifacts + a committed query set. A deterministic **run** phase mirrors `examples/playground.ts` (create DB → migrate(flags) → index corpus → search every query → score → drop DB). Pure scoring/cleaning logic is unit-tested; scraping/extraction/the live run are integration/authoring tasks.

**Tech Stack:** Bun + TypeScript (ES2022, ESM `.js` import specifiers), `bun:test`, Biome; the library's public API (`RagIndexer`, `RagPipeline`, `Chunker`, `LanguageNormalizer`, `PostgresRagDatabase`, `Bm25Fts`, `ragMigrate`); `postgres` (postgres.js); Python 3 + `pypdf` (PDF extraction only); WebFetch/Playwright (FAQ scraping, prep only).

## Global Constraints

- **No `src/` changes.** This is an example harness over the existing public API.
- **ESM import specifiers end in `.js`** (e.g. `import { X } from "../../src/index.js"`), resolved by Bun/bundler to `.ts`. Files in `examples/benchmark/` import the library as `../../src/index.js`.
- **`tsconfig` excludes `examples/` and `tests/`** — `bun run typecheck` does NOT cover benchmark code. Verify with `bun test` (logic) and `bun run lint` (Biome covers `**`).
- **All SQL parameterized; never interpolate user input** (only the playground's `CREATE/DROP DATABASE` admin statements use `unsafe`, copied verbatim).
- **Tenant id:** `00000000-0000-0000-0000-000000000099` (reuse the playground constant).
- **Corpus language is `"ar"`** for all indexed docs and the query `language`.
- **Do not commit scraped/extracted text.** Committed: code, tests, `queries.json`, `README.md`, `scrape-notes.md`. Gitignored (under already-ignored `datasets/`): `datasets/faqs/*.jsonl`, `datasets/benchmark-cache/*.jsonl`. Add `examples/benchmark/results/` to `.gitignore`.
- **Biome formatting:** 2-space indent, line width 100, organize imports on.

## File Structure

```
examples/benchmark/
  types.ts          # shared TS types (Dialect, Domain, FaqRecord, CorpusChunk, BenchmarkQuery, QueriesFile)
  metrics.ts        # PURE: recallAtK, reciprocalRank, ndcgAtK, summarize, sliceBy
  qrels.ts          # PURE: loadQueries, resolveQueries (target_doc ∈ corpus), snippetPresent
  cleanArabic.ts    # PURE: arabicRatio, isArabicDominant, stripRecurringBoilerplate, cleanArabicDoc
  embeddingCache.ts # PURE-ish: withEmbeddingCache(inner) -> EmbeddingProvider (memoize by text)
  infra.ts          # wiring copied/adapted from playground: DB lifecycle, adapter, embedder, reranker, logger
  extract_pdfs.py   # pypdf raw per-page extraction -> datasets/benchmark-cache/extracted.jsonl
  buildCorpus.ts    # faqs + extracted -> cleanArabic + Chunker -> datasets/benchmark-cache/corpus.jsonl
  judge.ts          # optional LLM-as-judge over a query slice (chat endpoint), opt-in
  run.ts            # orchestrator: flags, DB lifecycle, indexing, query loop, metrics, reporting, --matrix
  queries.json      # COMMITTED authored dialect queries + target_doc + target_snippet
  README.md         # prereqs + prep + run instructions
  scrape-notes.md   # provenance: FAQ URLs + scrape method
tests/
  benchmark-metrics.test.ts
  benchmark-qrels.test.ts
  benchmark-cleanArabic.test.ts
  benchmark-embeddingCache.test.ts
datasets/                       # gitignored
  PDFs/*.pdf                    # already present
  faqs/<provider>.jsonl         # FAQ snapshots (prep output)
  benchmark-cache/extracted.jsonl
  benchmark-cache/corpus.jsonl
```

---

### Task 1: Shared types

**Files:**
- Create: `examples/benchmark/types.ts`

**Interfaces:**
- Produces: `Dialect`, `Domain`, `FaqRecord`, `ExtractedPdf`, `CorpusChunk`, `BenchmarkQuery`, `QueriesFile` (used by every later TS task).

- [ ] **Step 1: Write the file**

```ts
// examples/benchmark/types.ts
export type Dialect = "msa" | "saudi" | "darija";
export type Domain = "banking" | "telecom";

/** One scraped FAQ pair. doc_id = "faq:<provider>:<ordinal>". */
export interface FaqRecord {
  doc_id: string;
  domain: Domain;
  provider: string;
  question: string;
  answer: string;
}

/** Raw pypdf extraction for one PDF. doc_id = "pdf:<provider>:<ordinal>". */
export interface ExtractedPdf {
  doc_id: string;
  provider: string;
  domain: Domain;
  title: string;
  pages: string[];
}

/** One indexable chunk. chunk_id = "<doc_id>#<index>". */
export interface CorpusChunk {
  chunk_id: string;
  doc_id: string;
  source: "faq" | "pdf";
  domain: Domain;
  provider: string;
  language: string;
  content: string;
}

/** A scored query with three dialect variants sharing one target document. */
export interface BenchmarkQuery {
  id: string;
  domain: Domain;
  provider: string;
  target_doc: string;
  target_snippet: string;
  variants: Record<Dialect, string>;
}

export interface QueriesFile {
  version: number;
  queries: BenchmarkQuery[];
}
```

- [ ] **Step 2: Verify it lints/parses**

Run: `bun run lint examples/benchmark/types.ts`
Expected: no errors (Biome may reformat; that's fine).

- [ ] **Step 3: Commit**

```bash
git add examples/benchmark/types.ts
git commit -m "feat(benchmark): shared types"
```

---

### Task 2: Metrics (pure)

**Files:**
- Create: `examples/benchmark/metrics.ts`
- Test: `tests/benchmark-metrics.test.ts`

**Interfaces:**
- Consumes: `Dialect` from `./types.js`.
- Produces: `recallAtK(rankedDocIds, targetDoc, k)`, `reciprocalRank(rankedDocIds, targetDoc, cap=10)`, `ndcgAtK(rankedDocIds, targetDoc, k=10)`, `QueryOutcome`, `MetricSummary`, `summarize(outcomes)`, `sliceBy(outcomes, key)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/benchmark-metrics.test.ts
import { expect, test } from "bun:test";
import {
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  sliceBy,
  summarize,
} from "../examples/benchmark/metrics.js";
import type { QueryOutcome } from "../examples/benchmark/metrics.js";

test("recallAtK: 1 iff target within top-k", () => {
  expect(recallAtK(["a", "b", "c"], "b", 3)).toBe(1);
  expect(recallAtK(["a", "b", "c"], "b", 1)).toBe(0);
  expect(recallAtK(["a", "b", "c"], "z", 3)).toBe(0);
});

test("reciprocalRank: 1/rank of first hit within cap", () => {
  expect(reciprocalRank(["a", "b", "c"], "a")).toBe(1);
  expect(reciprocalRank(["a", "b", "c"], "c")).toBeCloseTo(1 / 3);
  expect(reciprocalRank(["x", "y"], "z")).toBe(0);
});

test("ndcgAtK: binary single-relevant", () => {
  expect(ndcgAtK(["a"], "a")).toBe(1);
  expect(ndcgAtK(["x", "a"], "a")).toBeCloseTo(1 / Math.log2(3));
  expect(ndcgAtK(["x", "y"], "a", 2)).toBe(0);
});

test("summarize + sliceBy", () => {
  const outcomes: QueryOutcome[] = [
    { rankedDocIds: ["a"], targetDoc: "a", dialect: "msa", domain: "banking", provider: "p", source: "faq" },
    { rankedDocIds: ["x", "b"], targetDoc: "b", dialect: "saudi", domain: "banking", provider: "p", source: "faq" },
  ];
  const s = summarize(outcomes);
  expect(s.n).toBe(2);
  expect(s.recallAt1).toBe(0.5);
  expect(s.recallAt3).toBe(1);
  expect(s.mrr10).toBeCloseTo((1 + 0.5) / 2);
  const byDialect = sliceBy(outcomes, (o) => o.dialect);
  expect(byDialect.get("msa")?.recallAt1).toBe(1);
  expect(byDialect.get("saudi")?.recallAt1).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/benchmark-metrics.test.ts`
Expected: FAIL (cannot resolve `../examples/benchmark/metrics.js`).

- [ ] **Step 3: Write the implementation**

```ts
// examples/benchmark/metrics.ts
import type { Dialect } from "./types.js";

/** 1 if targetDoc appears among the first k ranked doc ids, else 0. */
export function recallAtK(rankedDocIds: string[], targetDoc: string, k: number): number {
  return rankedDocIds.slice(0, k).includes(targetDoc) ? 1 : 0;
}

/** Reciprocal rank of the first occurrence of targetDoc within `cap` (0 if absent). */
export function reciprocalRank(rankedDocIds: string[], targetDoc: string, cap = 10): number {
  const idx = rankedDocIds.slice(0, cap).indexOf(targetDoc);
  return idx === -1 ? 0 : 1 / (idx + 1);
}

/** Binary-relevance nDCG@k for a single relevant doc (IDCG = 1). */
export function ndcgAtK(rankedDocIds: string[], targetDoc: string, k = 10): number {
  const idx = rankedDocIds.slice(0, k).indexOf(targetDoc);
  return idx === -1 ? 0 : 1 / Math.log2(idx + 2);
}

export interface QueryOutcome {
  rankedDocIds: string[];
  targetDoc: string;
  dialect: Dialect;
  domain: string;
  provider: string;
  source: string;
}

export interface MetricSummary {
  n: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  recallAt10: number;
  mrr10: number;
  ndcg10: number;
}

export function summarize(outcomes: QueryOutcome[]): MetricSummary {
  const n = outcomes.length;
  const empty: MetricSummary = {
    n: 0, recallAt1: 0, recallAt3: 0, recallAt5: 0, recallAt10: 0, mrr10: 0, ndcg10: 0,
  };
  if (n === 0) return empty;
  const mean = (f: (o: QueryOutcome) => number) => outcomes.reduce((s, o) => s + f(o), 0) / n;
  return {
    n,
    recallAt1: mean((o) => recallAtK(o.rankedDocIds, o.targetDoc, 1)),
    recallAt3: mean((o) => recallAtK(o.rankedDocIds, o.targetDoc, 3)),
    recallAt5: mean((o) => recallAtK(o.rankedDocIds, o.targetDoc, 5)),
    recallAt10: mean((o) => recallAtK(o.rankedDocIds, o.targetDoc, 10)),
    mrr10: mean((o) => reciprocalRank(o.rankedDocIds, o.targetDoc, 10)),
    ndcg10: mean((o) => ndcgAtK(o.rankedDocIds, o.targetDoc, 10)),
  };
}

/** Group outcomes by a key function and summarize each group. */
export function sliceBy(
  outcomes: QueryOutcome[],
  key: (o: QueryOutcome) => string,
): Map<string, MetricSummary> {
  const groups = new Map<string, QueryOutcome[]>();
  for (const o of outcomes) {
    const k = key(o);
    const g = groups.get(k) ?? [];
    g.push(o);
    groups.set(k, g);
  }
  const out = new Map<string, MetricSummary>();
  for (const [k, v] of groups) out.set(k, summarize(v));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/benchmark-metrics.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/benchmark/metrics.ts tests/benchmark-metrics.test.ts
git commit -m "feat(benchmark): retrieval metrics (recall/MRR/nDCG) + slicing"
```

---

### Task 3: Qrels resolution (pure)

**Files:**
- Create: `examples/benchmark/qrels.ts`
- Test: `tests/benchmark-qrels.test.ts`

**Interfaces:**
- Consumes: `BenchmarkQuery`, `QueriesFile` from `./types.js`.
- Produces: `loadQueries(path): QueriesFile`, `resolveQueries(queries, corpusDocIds: Set<string>): { resolved: BenchmarkQuery[]; unresolved: BenchmarkQuery[] }`, `snippetPresent(snippet, docText, normalize): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/benchmark-qrels.test.ts
import { expect, test } from "bun:test";
import { resolveQueries, snippetPresent } from "../examples/benchmark/qrels.js";
import type { BenchmarkQuery } from "../examples/benchmark/types.js";

const q = (id: string, target: string): BenchmarkQuery => ({
  id,
  domain: "banking",
  provider: "p",
  target_doc: target,
  target_snippet: "x",
  variants: { msa: "m", saudi: "s", darija: "d" },
});

test("resolveQueries partitions on target_doc membership", () => {
  const corpus = new Set(["faq:p:1", "faq:p:2"]);
  const { resolved, unresolved } = resolveQueries([q("a", "faq:p:1"), q("b", "faq:p:9")], corpus);
  expect(resolved.map((x) => x.id)).toEqual(["a"]);
  expect(unresolved.map((x) => x.id)).toEqual(["b"]);
});

test("snippetPresent uses the provided normalizer", () => {
  const upper = (s: string) => s.toUpperCase();
  expect(snippetPresent("abc", "xx abc yy", upper)).toBe(true);
  expect(snippetPresent("zzz", "xx abc yy", upper)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/benchmark-qrels.test.ts`
Expected: FAIL (cannot resolve module).

- [ ] **Step 3: Write the implementation**

```ts
// examples/benchmark/qrels.ts
import { readFileSync } from "node:fs";
import type { BenchmarkQuery, QueriesFile } from "./types.js";

export function loadQueries(path: string): QueriesFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as QueriesFile;
  if (!parsed || typeof parsed.version !== "number" || !Array.isArray(parsed.queries)) {
    throw new Error(`Malformed queries file: ${path}`);
  }
  return parsed;
}

/** Partition queries by whether their target_doc exists in the built corpus. */
export function resolveQueries(
  queries: BenchmarkQuery[],
  corpusDocIds: Set<string>,
): { resolved: BenchmarkQuery[]; unresolved: BenchmarkQuery[] } {
  const resolved: BenchmarkQuery[] = [];
  const unresolved: BenchmarkQuery[] = [];
  for (const query of queries) {
    (corpusDocIds.has(query.target_doc) ? resolved : unresolved).push(query);
  }
  return { resolved, unresolved };
}

/** True if the (normalized) target snippet appears in the (normalized) doc text. */
export function snippetPresent(
  snippet: string,
  docText: string,
  normalize: (s: string) => string,
): boolean {
  return normalize(docText).includes(normalize(snippet));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/benchmark-qrels.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/benchmark/qrels.ts tests/benchmark-qrels.test.ts
git commit -m "feat(benchmark): qrels loading + target-doc resolution"
```

---

### Task 4: Arabic text cleaning (pure)

**Files:**
- Create: `examples/benchmark/cleanArabic.ts`
- Test: `tests/benchmark-cleanArabic.test.ts`

**Interfaces:**
- Produces: `arabicRatio(text): number`, `isArabicDominant(text, threshold=0.5): boolean`, `stripRecurringBoilerplate(pages: string[], minFraction=0.5): string[]`, `cleanArabicDoc(pages: string[], threshold=0.5): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/benchmark-cleanArabic.test.ts
import { expect, test } from "bun:test";
import {
  arabicRatio,
  cleanArabicDoc,
  isArabicDominant,
  stripRecurringBoilerplate,
} from "../examples/benchmark/cleanArabic.js";

test("arabicRatio counts Arabic letters over all letters", () => {
  expect(arabicRatio("مرحبا")).toBe(1);
  expect(arabicRatio("hello")).toBe(0);
  expect(arabicRatio("12345 ؟!")).toBe(0); // no letters -> 0
  expect(arabicRatio("ab مرحبا")).toBeCloseTo(5 / 7);
});

test("isArabicDominant honors threshold", () => {
  expect(isArabicDominant("مرحبا hello", 0.4)).toBe(true);
  expect(isArabicDominant("hello world مر", 0.5)).toBe(false);
});

test("stripRecurringBoilerplate drops lines on >= half the pages", () => {
  const pages = [
    "HEADER\nالسطر الأول",
    "HEADER\nالسطر الثاني",
    "HEADER\nالسطر الثالث",
  ];
  const out = stripRecurringBoilerplate(pages);
  expect(out.join("\n").includes("HEADER")).toBe(false);
  expect(out.join("\n").includes("السطر الأول")).toBe(true);
});

test("cleanArabicDoc strips boilerplate and keeps Arabic lines", () => {
  const pages = [
    "Restricted\nمحتوى عربي مفيد\nEnglish only line",
    "Restricted\nسطر عربي آخر\nAnother english line",
  ];
  const out = cleanArabicDoc(pages);
  expect(out.includes("محتوى عربي مفيد")).toBe(true);
  expect(out.includes("سطر عربي آخر")).toBe(true);
  expect(out.includes("Restricted")).toBe(false);
  expect(out.includes("English only line")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/benchmark-cleanArabic.test.ts`
Expected: FAIL (cannot resolve module).

- [ ] **Step 3: Write the implementation**

```ts
// examples/benchmark/cleanArabic.ts

/** Fraction of letter characters that are in the Arabic block (0 if no letters). */
export function arabicRatio(text: string): number {
  let arabic = 0;
  let letters = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isArabic = code >= 0x0600 && code <= 0x06ff;
    const isLatin = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (isArabic || isLatin) letters++;
    if (isArabic) arabic++;
  }
  return letters === 0 ? 0 : arabic / letters;
}

export function isArabicDominant(text: string, threshold = 0.5): boolean {
  return arabicRatio(text) >= threshold;
}

/**
 * Drop lines that recur on at least `minFraction` of pages (repeated headers/footers).
 * Comparison is on the trimmed line; blank lines are never treated as boilerplate.
 */
export function stripRecurringBoilerplate(pages: string[], minFraction = 0.5): string[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const raw of page.split("\n")) {
      const line = raw.trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * minFraction));
  const boilerplate = new Set(
    [...counts.entries()].filter(([, c]) => c >= threshold).map(([line]) => line),
  );
  return pages.map((page) =>
    page.split("\n").filter((raw) => !boilerplate.has(raw.trim())).join("\n"),
  );
}

/**
 * Clean a multi-page PDF extraction into Arabic-dominant text: strip recurring
 * boilerplate, keep Arabic-dominant lines, join with newlines.
 */
export function cleanArabicDoc(pages: string[], threshold = 0.5): string {
  const stripped = stripRecurringBoilerplate(pages);
  const kept: string[] = [];
  for (const page of stripped) {
    for (const raw of page.split("\n")) {
      const line = raw.trim();
      if (line && isArabicDominant(line, threshold)) kept.push(line);
    }
  }
  return kept.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/benchmark-cleanArabic.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/benchmark/cleanArabic.ts tests/benchmark-cleanArabic.test.ts
git commit -m "feat(benchmark): Arabic text cleaning (boilerplate strip + script filter)"
```

---

### Task 5: Embedding cache (pure-ish)

**Files:**
- Create: `examples/benchmark/embeddingCache.ts`
- Test: `tests/benchmark-embeddingCache.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider` from `../../src/index.js`.
- Produces: `withEmbeddingCache(inner: EmbeddingProvider): EmbeddingProvider` — memoizes both `embedDocuments` and `embedQuery` by exact text; returns vectors in input order.

- [ ] **Step 1: Write the failing test**

```ts
// tests/benchmark-embeddingCache.test.ts
import { expect, test } from "bun:test";
import { withEmbeddingCache } from "../examples/benchmark/embeddingCache.js";

test("embedDocuments embeds each unique text once, preserves order", async () => {
  const calls: string[][] = [];
  const inner = {
    embedQuery: async (t: string) => [t.length],
    embedDocuments: async (texts: string[]) => {
      calls.push(texts);
      return texts.map((t) => [t.length]);
    },
  };
  const cached = withEmbeddingCache(inner);

  const r1 = await cached.embedDocuments(["aa", "bbb", "aa"]);
  expect(r1).toEqual([[2], [3], [2]]);
  expect(calls).toEqual([["aa", "bbb"]]); // "aa" embedded once, deduped

  const r2 = await cached.embedDocuments(["bbb", "cccc"]);
  expect(r2).toEqual([[3], [4]]);
  expect(calls).toEqual([["aa", "bbb"], ["cccc"]]); // only the new text

  // embedQuery hits the same cache
  calls.length = 0;
  expect(await cached.embedQuery("aa")).toEqual([2]);
  expect(calls).toEqual([]); // served from cache, no inner call
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/benchmark-embeddingCache.test.ts`
Expected: FAIL (cannot resolve module).

- [ ] **Step 3: Write the implementation**

```ts
// examples/benchmark/embeddingCache.ts
import type { EmbeddingProvider } from "../../src/index.js";

/**
 * Wrap an embedder with an in-memory cache keyed by exact text, so a chunk or query
 * embedded once (e.g. across a --matrix sweep that re-indexes the same corpus) is not
 * re-embedded. Returns vectors in input order.
 */
export function withEmbeddingCache(inner: EmbeddingProvider): EmbeddingProvider {
  const cache = new Map<string, number[]>();

  async function embedDocuments(texts: string[]): Promise<number[][]> {
    const missing: string[] = [];
    for (const t of texts) {
      if (!cache.has(t) && !missing.includes(t)) missing.push(t);
    }
    if (missing.length > 0) {
      const fresh = await inner.embedDocuments(missing);
      missing.forEach((t, i) => cache.set(t, fresh[i]));
    }
    return texts.map((t) => cache.get(t) as number[]);
  }

  async function embedQuery(text: string): Promise<number[]> {
    const hit = cache.get(text);
    if (hit) return hit;
    const [vec] = await embedDocuments([text]);
    return vec;
  }

  return { embedQuery, embedDocuments };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/benchmark-embeddingCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/benchmark/embeddingCache.ts tests/benchmark-embeddingCache.test.ts
git commit -m "feat(benchmark): text-keyed embedding cache"
```

---

### Task 6: Infra wiring (DB lifecycle, embedder, reranker)

**Files:**
- Create: `examples/benchmark/infra.ts`

**Interfaces:**
- Consumes: the playground's existing wiring (`examples/playground.ts` lines ~37–196), `postgres`, `OpenAiCompatibleEmbedder`, `RerankerProvider`, `SqlClient`, `TransactionProvider` from `../../src/index.js`.
- Produces (exports):
  - `buildDatabaseUrl(): string` — copy of playground lines 37–49.
  - `withDatabase(url: string, dbName: string): string` — copy of playground lines 69–73.
  - `createDatabase(adminUrl: string, dbName: string): Promise<void>` — generalized from playground `createPlaygroundDb` (lines 76–82): take `dbName` param instead of the `PLAYGROUND_DB` constant.
  - `dropDatabase(adminUrl: string, dbName: string): Promise<void>` — generalized from playground `dropPlaygroundDb` (lines 84–92).
  - `createAdapter(sql: postgres.Sql): { txProvider: TransactionProvider; migrationProvider: TransactionProvider; sql: postgres.Sql }` — copy of playground lines 96–121 (the reserving provider) verbatim.
  - `createEmbedder(): EmbeddingProvider` — read `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY ?? LLM_API_KEY`, `EMBEDDING_MODEL` from env (playground lines 52–61, 125–129); throw a clear error if any are missing.
  - `createReranker(): RerankerProvider | undefined` — read `RERANKER_BASE_URL`/`RERANKER_API_KEY`; if base url unset return `undefined`; else return the TEI `/rerank` batched reranker (copy of playground lines 138–188, `RERANK_BATCH_SIZE = 8`).
  - `logger` — copy of playground lines 192–196.
  - `TENANT_ID = "00000000-0000-0000-0000-000000000099"`.

- [ ] **Step 1: Create the module**

Copy the named regions from `examples/playground.ts` listed above into `examples/benchmark/infra.ts`, adjusting:
- import path to `../../src/index.js` (one level deeper than the playground's `../src/index.js`).
- `createDatabase`/`dropDatabase` take a `dbName` parameter (and `adminUrl`) instead of closing over module constants; otherwise the body (DROP IF EXISTS, CREATE, `pg_terminate_backend`) is unchanged.
- Export every symbol listed under **Produces**.
- `createEmbedder`/`createReranker` read from `process.env` exactly as the playground does.

- [ ] **Step 2: Verify it lints and imports resolve**

Run: `bun run lint examples/benchmark/infra.ts`
Expected: no errors.

Run: `bun -e "import('./examples/benchmark/infra.js').then(m => console.log(Object.keys(m).sort().join(',')))"`
Expected: prints the exported names including `buildDatabaseUrl,createAdapter,createDatabase,createEmbedder,createReranker,dropDatabase,logger,withDatabase` (TENANT_ID too). (No DB/env needed — module load only.)

- [ ] **Step 3: Commit**

```bash
git add examples/benchmark/infra.ts
git commit -m "feat(benchmark): infra wiring (DB lifecycle, embedder, reranker) from playground"
```

---

### Task 7: PDF extraction (Python prep)

**Files:**
- Create: `examples/benchmark/extract_pdfs.py`
- Output (gitignored): `datasets/benchmark-cache/extracted.jsonl`

**Interfaces:**
- Produces: `extracted.jsonl`, one JSON object per PDF: `{ "doc_id": "pdf:<provider>:<ordinal>", "provider": "<slug>", "domain": "banking"|"telecom", "title": "<filename>", "pages": ["<page1 text>", ...] }`.

This is an **integration/prep task** (no unit test; runs against real PDFs).

- [ ] **Step 1: Write the script**

```python
# examples/benchmark/extract_pdfs.py
"""Raw per-page text extraction for the Arabic RAG benchmark.
Cleaning (boilerplate strip + Arabic-script filter) happens in TS (cleanArabic.ts);
this script only extracts text with pypdf. Usage: python examples/benchmark/extract_pdfs.py
"""
import json
import os
import sys
from pypdf import PdfReader

PDF_DIR = os.path.join("datasets", "PDFs")
OUT_DIR = os.path.join("datasets", "benchmark-cache")
OUT = os.path.join(OUT_DIR, "extracted.jsonl")

# provider slug + domain per known filename prefix; default provider = filename stem, domain banking.
DOMAIN_BY_KEYWORD = [("etisalat", "telecom"), ("eand", "telecom")]

def classify(filename: str):
    stem = os.path.splitext(filename)[0]
    provider = stem.split("_")[0]
    domain = "banking"
    for kw, dom in DOMAIN_BY_KEYWORD:
        if kw in stem.lower():
            domain = dom
            break
    return provider, domain

def main():
    if not os.path.isdir(PDF_DIR):
        print(f"No {PDF_DIR}/ directory; nothing to extract.", file=sys.stderr)
        return
    os.makedirs(OUT_DIR, exist_ok=True)
    pdfs = sorted(f for f in os.listdir(PDF_DIR) if f.lower().endswith(".pdf"))
    with open(OUT, "w", encoding="utf-8") as out:
        for ordinal, fn in enumerate(pdfs):
            provider, domain = classify(fn)
            try:
                reader = PdfReader(os.path.join(PDF_DIR, fn))
                pages = [(p.extract_text() or "") for p in reader.pages]
            except Exception as e:  # noqa: BLE001 - prep tool, log and skip
                print(f"SKIP {fn}: {e}", file=sys.stderr)
                continue
            rec = {
                "doc_id": f"pdf:{provider}:{ordinal}",
                "provider": provider,
                "domain": domain,
                "title": fn,
                "pages": pages,
            }
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            print(f"  {fn} -> {len(pages)} pages (provider={provider}, domain={domain})")
    print(f"Wrote {OUT}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it**

Run: `python examples/benchmark/extract_pdfs.py`
Expected: prints one line per PDF in `datasets/PDFs/` with page counts; writes `datasets/benchmark-cache/extracted.jsonl`.

- [ ] **Step 3: Verify output shape**

Run: `bun -e "const fs=require('fs');const l=fs.readFileSync('datasets/benchmark-cache/extracted.jsonl','utf8').trim().split('\n');const r=JSON.parse(l[0]);console.log('docs',l.length,'first',r.doc_id,r.domain,'pages',r.pages.length)"`
Expected: `docs N first pdf:<provider>:0 <domain> pages M` with N ≥ 1 and M ≥ 1.

- [ ] **Step 4: Commit (code only — output is gitignored)**

```bash
git add examples/benchmark/extract_pdfs.py
git commit -m "feat(benchmark): pypdf per-page PDF extraction (prep)"
```

---

### Task 8: Scrape FAQ help centers → snapshot (prep/authoring)

**Files:**
- Output (gitignored): `datasets/faqs/<provider>.jsonl`
- Create: `examples/benchmark/scrape-notes.md`

**Interfaces:**
- Produces: per-provider JSONL, one object per FAQ pair: `{ "doc_id": "faq:<provider>:<ordinal>", "domain": "banking"|"telecom", "provider": "<slug>", "question": "<verbatim AR question>", "answer": "<verbatim AR answer>" }`.

This is an **authoring/integration task** performed by the orchestrating agent (uses WebFetch; Playwright fallback for JS-rendered pages). Not unit-tested.

- [ ] **Step 1: Fetch FAQ pages and capture Q&A**

Use WebFetch on server-rendered help centers (confirmed working: Zain Kuwait `https://www.kw.zain.com/ar/faq`; ABK `https://abk.eahli.com/ar/help-and-support/faqs/online-banking/`). Try additional banking providers (SAB `https://www.sab.com/ar/personal/help-and-support/faqs/`, Boubyan `https://www.bankboubyan.com/ar/faq`, SAMA consumer-protection FAQ pages). For JS-rendered pages (e.g. STC) that return no text, use the Playwright MCP `browser_navigate` + `browser_snapshot` to read rendered Q&A.

- [ ] **Step 2: Write per-provider snapshots**

For each provider, write `datasets/faqs/<provider>.jsonl` with verbatim Arabic question/answer pairs, assigning `doc_id = faq:<provider>:<ordinal>` (ordinal = line index, 0-based), correct `domain`, and `provider` slug. Drop pairs with terse, content-free answers (e.g. one-clause "yes, visit a branch").

**Acceptance criteria:**
- ≥ 2 providers, covering **both** `banking` and `telecom`.
- ≥ 60 total pairs across providers, each with a substantive (≥ ~80-char) answer.
- Every record validates: non-empty `question`, `answer`, unique `doc_id`.

Verify: `bun -e "const fs=require('fs');let n=0,doms=new Set();for(const f of fs.readdirSync('datasets/faqs')){for(const ln of fs.readFileSync('datasets/faqs/'+f,'utf8').trim().split('\n')){const r=JSON.parse(ln);n++;doms.add(r.domain);if(!r.question||!r.answer||!r.doc_id)throw new Error('bad row in '+f)}}console.log('pairs',n,'domains',[...doms].sort().join(','))"`
Expected: `pairs >=60 domains banking,telecom`.

- [ ] **Step 3: Record provenance**

Write `examples/benchmark/scrape-notes.md`: per provider — source URL(s), scrape method (WebFetch/Playwright), date, domain, approx pair count, and a note that snapshots are gitignored (not redistributed).

- [ ] **Step 4: Commit (notes only — snapshots are gitignored)**

```bash
git add examples/benchmark/scrape-notes.md
git commit -m "docs(benchmark): FAQ scrape provenance notes"
```

---

### Task 9: Build corpus (chunk FAQs + PDFs)

**Files:**
- Create: `examples/benchmark/buildCorpus.ts`
- Output (gitignored): `datasets/benchmark-cache/corpus.jsonl`

**Interfaces:**
- Consumes: `cleanArabicDoc` from `./cleanArabic.js`; `Chunker` from `../../src/index.js`; `FaqRecord`, `ExtractedPdf`, `CorpusChunk` from `./types.js`.
- Produces: `buildCorpus(): CorpusChunk[]` (also writes `corpus.jsonl` when run as a script) and `loadOrBuildCorpus(): CorpusChunk[]` (read the cached jsonl if present, else build + write).

Mostly integration glue (depends on Tasks 4 + 7 + 8 outputs); the cleaning it relies on is already unit-tested.

- [ ] **Step 1: Write the module**

Behavior:
1. Read every `datasets/faqs/*.jsonl` → `FaqRecord[]`.
2. Read `datasets/benchmark-cache/extracted.jsonl` → `ExtractedPdf[]` (skip if absent — PDFs are optional distractors).
3. For each FAQ: doc content = the **answer** (`record.answer`). Chunk with `new Chunker({ tokenLimit: 512, overlap: 75 })`, `chunker.chunk(answer, { language: "ar" })`. Emit `CorpusChunk`s with `source:"faq"`, `domain`/`provider` from the record, `chunk_id = \`${doc_id}#${chunk.index}\``.
   - Honor a `--include-question-in-doc` argv flag (default off): when set, doc content = `question + "\n" + answer`. (Documented escape hatch from the spec.)
4. For each PDF: `cleanArabicDoc(extracted.pages)` → text; skip if empty; chunk identically; emit `source:"pdf"`.
5. Write all chunks to `datasets/benchmark-cache/corpus.jsonl` (one JSON object per line). Print counts by `source` and `domain`.
6. `loadOrBuildCorpus()`: if `corpus.jsonl` exists, parse and return it; else call `buildCorpus()`.

```ts
// examples/benchmark/buildCorpus.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chunker } from "../../src/index.js";
import { cleanArabicDoc } from "./cleanArabic.js";
import type { CorpusChunk, ExtractedPdf, FaqRecord } from "./types.js";

const FAQ_DIR = join("datasets", "faqs");
const CACHE_DIR = join("datasets", "benchmark-cache");
const EXTRACTED = join(CACHE_DIR, "extracted.jsonl");
const CORPUS = join(CACHE_DIR, "corpus.jsonl");

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

export function buildCorpus(includeQuestion = false): CorpusChunk[] {
  const chunker = new Chunker({ tokenLimit: 512, overlap: 75 });
  const out: CorpusChunk[] = [];

  // FAQ answers (scored targets)
  const faqFiles = existsSync(FAQ_DIR) ? readdirSync(FAQ_DIR).filter((f) => f.endsWith(".jsonl")) : [];
  for (const file of faqFiles) {
    for (const rec of readJsonl<FaqRecord>(join(FAQ_DIR, file))) {
      const content = includeQuestion ? `${rec.question}\n${rec.answer}` : rec.answer;
      for (const chunk of chunker.chunk(content, { language: "ar" })) {
        out.push({
          chunk_id: `${rec.doc_id}#${chunk.index}`,
          doc_id: rec.doc_id,
          source: "faq",
          domain: rec.domain,
          provider: rec.provider,
          language: "ar",
          content: chunk.content,
        });
      }
    }
  }

  // PDF distractors
  for (const pdf of readJsonl<ExtractedPdf>(EXTRACTED)) {
    const text = cleanArabicDoc(pdf.pages);
    if (!text.trim()) continue;
    for (const chunk of chunker.chunk(text, { language: "ar" })) {
      out.push({
        chunk_id: `${pdf.doc_id}#${chunk.index}`,
        doc_id: pdf.doc_id,
        source: "pdf",
        domain: pdf.domain,
        provider: pdf.provider,
        language: "ar",
        content: chunk.content,
      });
    }
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CORPUS, `${out.map((c) => JSON.stringify(c)).join("\n")}\n`, "utf8");
  const bySource = (s: string) => out.filter((c) => c.source === s).length;
  console.log(`corpus: ${out.length} chunks (faq=${bySource("faq")}, pdf=${bySource("pdf")})`);
  return out;
}

export function loadOrBuildCorpus(includeQuestion = false): CorpusChunk[] {
  if (existsSync(CORPUS)) return readJsonl<CorpusChunk>(CORPUS);
  return buildCorpus(includeQuestion);
}

if (import.meta.main) {
  buildCorpus(process.argv.includes("--include-question-in-doc"));
}
```

- [ ] **Step 2: Run it**

Run: `bun run examples/benchmark/buildCorpus.ts`
Expected: prints `corpus: N chunks (faq=…, pdf=…)` with faq ≥ the FAQ pair count; writes `datasets/benchmark-cache/corpus.jsonl`.

- [ ] **Step 3: Verify doc-id stability + uniqueness**

Run: `bun -e "import('./examples/benchmark/buildCorpus.js').then(m=>{const a=m.loadOrBuildCorpus();const ids=new Set(a.map(c=>c.chunk_id));console.log('chunks',a.length,'unique',ids.size,'docs',new Set(a.map(c=>c.doc_id)).size)})"`
Expected: `chunks N unique N docs M` (chunk_id unique; M ≤ N).

- [ ] **Step 4: Commit (code only)**

```bash
git add examples/benchmark/buildCorpus.ts
git commit -m "feat(benchmark): build corpus (chunk FAQ answers + PDF distractors)"
```

---

### Task 10: Author dialect queries → `queries.json` (authoring)

**Files:**
- Create: `examples/benchmark/queries.json` (COMMITTED)

**Interfaces:**
- Consumes: the FAQ snapshots (Task 8) and built corpus doc ids (Task 9).
- Produces: a `QueriesFile` (Task 1 schema) the runner loads.

This is an **authoring task** by the orchestrating agent (writes dialectal Arabic). Not unit-tested; validated structurally.

- [ ] **Step 1: Select pairs and author variants**

For ~60–100 FAQ pairs balanced across banking/telecom, create one `BenchmarkQuery` each:
- `id`: `q0001`… (zero-padded, unique).
- `target_doc`: the FAQ pair's `doc_id`.
- `target_snippet`: a verbatim ~40–80-char substring of that pair's answer.
- `variants.msa`: the **real FAQ question, verbatim**.
- `variants.saudi`: a Saudi-dialect rewrite of the question (ArBanking77 Saudi split as style reference).
- `variants.darija`: a Moroccan Darija rewrite (DarijaBanking as reference).
- `domain`/`provider`: from the FAQ record.

Write `{ "version": 1, "queries": [ ... ] }` to `examples/benchmark/queries.json` (UTF-8, ensure Arabic is not escaped or is valid `\u` — both parse fine).

**Acceptance criteria:** ≥ 60 queries; both domains present; every `target_doc` exists in the built corpus; every query has all three non-empty variants; ids unique.

- [ ] **Step 2: Validate structurally against the corpus**

Run:
```bash
bun -e "import('./examples/benchmark/qrels.js').then(async q=>{const {loadOrBuildCorpus}=await import('./examples/benchmark/buildCorpus.js');const corpus=loadOrBuildCorpus();const ids=new Set(corpus.map(c=>c.doc_id));const f=q.loadQueries('examples/benchmark/queries.json');const {resolved,unresolved}=q.resolveQueries(f.queries,ids);const doms=new Set(f.queries.map(x=>x.domain));const bad=f.queries.filter(x=>!x.variants.msa||!x.variants.saudi||!x.variants.darija);console.log('queries',f.queries.length,'resolved',resolved.length,'unresolved',unresolved.length,'domains',[...doms].sort().join(','),'missingVariants',bad.length)})"
```
Expected: `queries >=60 resolved == queries unresolved 0 domains banking,telecom missingVariants 0`.

- [ ] **Step 3: Commit**

```bash
git add examples/benchmark/queries.json
git commit -m "feat(benchmark): authored MSA/Saudi/Darija query set with target docs"
```

---

### Task 11: LLM-as-judge slice (optional, opt-in)

**Files:**
- Create: `examples/benchmark/judge.ts`

**Interfaces:**
- Consumes: `RagResult` from `../../src/index.js`.
- Produces: `parseJudgeScores(raw: string, n: number): number[]` (PURE — extract n integer 0/1/2 ratings from a model reply; default 0 on parse miss), and `judgeResults(query: string, results: RagResult[], cfg: JudgeConfig): Promise<number[]>` (calls a chat endpoint; aligns scores to `results`), plus `JudgeConfig` and `judgeEnabledFromEnv(): JudgeConfig | undefined`.

- [ ] **Step 1: Write the failing test for the pure parser**

```ts
// tests/benchmark-judge.test.ts
import { expect, test } from "bun:test";
import { parseJudgeScores } from "../examples/benchmark/judge.js";

test("parseJudgeScores extracts n leading 0/1/2 ratings", () => {
  expect(parseJudgeScores("2, 0, 1", 3)).toEqual([2, 0, 1]);
  expect(parseJudgeScores("scores: 1 1 2 0", 4)).toEqual([1, 1, 2, 0]);
  expect(parseJudgeScores("nonsense", 2)).toEqual([0, 0]); // miss -> zeros
  expect(parseJudgeScores("2 1", 3)).toEqual([2, 1, 0]); // pad short
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/benchmark-judge.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// examples/benchmark/judge.ts
import type { RagResult } from "../../src/index.js";

export interface JudgeConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Read JUDGE_* env; undefined if not fully configured. */
export function judgeEnabledFromEnv(): JudgeConfig | undefined {
  const baseUrl = process.env.JUDGE_BASE_URL;
  const model = process.env.JUDGE_MODEL;
  if (!baseUrl || !model) return undefined;
  return { baseUrl, model, apiKey: process.env.JUDGE_API_KEY };
}

/** Extract the first `n` integer 0/1/2 ratings from a model reply; pad/truncate to n; default 0. */
export function parseJudgeScores(raw: string, n: number): number[] {
  const nums = (raw.match(/[012]/g) ?? []).map(Number).slice(0, n);
  while (nums.length < n) nums.push(0);
  return nums;
}

/** Ask the chat model to rate each result 0/1/2 for relevance to the query. */
export async function judgeResults(
  query: string,
  results: RagResult[],
  cfg: JudgeConfig,
): Promise<number[]> {
  if (results.length === 0) return [];
  const blocks = results
    .map((r, i) => `[${i + 1}] ${r.content.slice(0, 500).replace(/\n/g, " ")}`)
    .join("\n");
  const prompt =
    `سؤال المستخدم: "${query}"\n` +
    `قيّم مدى صلة كل مقطع بالسؤال على مقياس 0 (غير ذي صلة)، 1 (ذو صلة جزئية)، 2 (يجيب على السؤال).\n` +
    `أعد الأرقام فقط بالترتيب ومفصولة بفواصل.\n${blocks}`;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Judge error ${res.status}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return parseJudgeScores(data.choices[0]?.message?.content ?? "", results.length);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/benchmark-judge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/benchmark/judge.ts tests/benchmark-judge.test.ts
git commit -m "feat(benchmark): optional LLM-as-judge slice (opt-in)"
```

---

### Task 12: Runner / orchestrator

**Files:**
- Create: `examples/benchmark/run.ts`
- Modify: `.gitignore` (add `examples/benchmark/results/`)

**Interfaces:**
- Consumes: `infra.ts` (DB lifecycle, embedder, reranker, logger, `TENANT_ID`), `loadOrBuildCorpus` (`buildCorpus.ts`), `loadQueries`/`resolveQueries` (`qrels.ts`), `metrics.ts` (`QueryOutcome`, `summarize`, `sliceBy`), `withEmbeddingCache` (`embeddingCache.ts`), `judge.ts` (optional); from `../../src/index.js`: `RagIndexer`, `RagPipeline`, `PostgresRagDatabase`, `Bm25Fts`, `LanguageNormalizer`, `ragMigrate`.

This is an **integration task** (needs a live DB + embedder, like the playground). Verified by running it, not by unit tests.

- [ ] **Step 1: Add results dir to .gitignore**

Append to `.gitignore`:
```
examples/benchmark/results/
```

- [ ] **Step 2: Write `run.ts`**

Structure (mirror `examples/playground.ts` lifecycle):
1. **Parse argv:** `--bm25`, `--vectorchord`, `--rerank`, `--cjk`, `--judge`, `--matrix`, `--topk N` (default 10), `--limit-queries N`.
2. **Define configs:** if `--matrix`, the preset list
   ```ts
   const MATRIX = [
     { name: "baseline",     bm25: false, vectorchord: false, rerank: false },
     { name: "+bm25",        bm25: true,  vectorchord: false, rerank: false },
     { name: "+vectorchord", bm25: false, vectorchord: true,  rerank: false },
     { name: "+rerank",      bm25: false, vectorchord: false, rerank: true  },
     { name: "all",          bm25: true,  vectorchord: true,  rerank: true  },
   ];
   ```
   else a single config from the flags (`name: "custom"`). `cjk` applies to all configs from the `--cjk` flag.
3. **Load** corpus (`loadOrBuildCorpus()`) and queries (`loadQueries("examples/benchmark/queries.json")`); resolve against `new Set(corpus.map(c=>c.doc_id))`; if `--limit-queries`, slice the resolved list. Log `unresolved.length` (excluded).
4. **Shared embedder:** `const embedder = withEmbeddingCache(createEmbedder())` (cache shared across configs so each unique chunk/query embeds once for the whole matrix).
5. **For each config:**
   a. `dbName = "arrag_bench_" + config.name.replace(/[^a-z0-9]/g, "")`; `createDatabase(adminUrl, dbName)`.
   b. Build adapter on `postgres(withDatabase(adminUrl, dbName), { max: 5 })`.
   c. `await ragMigrate(migrationProvider, { sqlDir: fileURLToPath(new URL("../../sql", import.meta.url)), vectorchord: config.vectorchord, bm25: config.bm25, cjk })`.
   d. Seed Arabic stop words (copy the playground's `ar` list → `rag_stop_words`) so the lexical legs match a real deployment; build `CachingStopWordsLoader` with `normalizeWord: normalizeForLanguage`.
   e. `db = new PostgresRagDatabase(txProvider, { ...(config.bm25 ? { fts: new Bm25Fts() } : {}), ...(cjk ? { cjk: true } : {}) })`.
   f. `indexer = new RagIndexer({ tenantId: TENANT_ID, db, embedder, normalizer: new LanguageNormalizer(), logger })`. Index every corpus chunk grouped by `doc_id`: for each doc, `indexer.index(chunk.source, doc_id, chunksOfDoc.map(c => ({ content: c.content, index: i, metadata: { language: "ar", domain: c.domain, provider: c.provider, source: c.source } })), "ar")`. (Group corpus chunks by `doc_id`; preserve order; pass the right `source` as `sourceType`.)
   g. `pipeline = new RagPipeline({ tenantId: TENANT_ID, db, embedder, normalizer: new LanguageNormalizer(), stopWords, logger, ...(config.rerank && reranker ? { reranker } : {}) })`.
   h. For each resolved query × each dialect variant: `const results = await pipeline.search(variantText, { topK, language: "ar", rerank: config.rerank })`; build a `QueryOutcome` with `rankedDocIds = results.map(r => r.sourceId ?? "")`, `targetDoc = query.target_doc`, `dialect`, `domain`, `provider`, `source: "faq"`.
   i. Drop the DB (`dropDatabase`) with the playground's bounded `sql.end({ timeout: 5 })` cleanup pattern (also on error).
6. **Report** per config: overall `summarize(outcomes)`, plus `sliceBy(outcomes, o=>o.dialect)` and `sliceBy(outcomes, o=>o.domain)`. Print a comparison table across configs (rows = config, columns = recall@1/3/5/10, mrr10, ndcg10) and the per-dialect breakdown. Print a disclosure header: corpus composition (faq/pdf counts, domains, providers) + "corpus is terms/policy + FAQ content".
7. **`--judge`:** if `judgeEnabledFromEnv()` returns a config, run `judgeResults` over a slice (first ~15 resolved queries' MSA variant) on the LAST config's pipeline before dropping its DB; report mean precision@k (fraction of returned results with score ≥ 1). If env missing, warn and skip.
8. **Write** `examples/benchmark/results/<Date.now()>.json` with all summaries (overall + slices per config). `mkdirSync` the dir.
9. **Crash safety:** top-level `.catch` that best-effort drops any created DB (track created db names), mirroring the playground's fatal handler.

Use exact API shapes confirmed in the spec: `RagResult.sourceId` is the indexed doc id; `RagPipeline.search(query, { topK, language, rerank })`; `RagIndexer.index(sourceType, sourceId, chunks, "ar")`.

- [ ] **Step 3: Lint**

Run: `bun run lint examples/benchmark/run.ts`
Expected: no errors.

- [ ] **Step 4: Smoke run (needs DB + embedder up)**

Prereq: `.env` populated (DATABASE_URL/POSTGRES_*, EMBEDDING_*), DB reachable (`cd examples && podman compose up -d`).
Run: `bun run examples/benchmark/run.ts --limit-queries 6`
Expected: creates `arrag_bench_custom`, migrates, indexes, runs 6×3 searches, prints metric tables with finite Recall/MRR/nDCG, drops the DB, writes a `results/*.json`.

- [ ] **Step 5: Matrix run**

Run: `bun run examples/benchmark/run.ts --matrix --limit-queries 6`
Expected: runs all 5 configs (each its own DB created+dropped), prints a comparison table; embedding cache means corpus chunks embed once total.

- [ ] **Step 6: Commit**

```bash
git add examples/benchmark/run.ts .gitignore
git commit -m "feat(benchmark): runner + flag matrix + metric reporting"
```

---

### Task 13: README

**Files:**
- Create: `examples/benchmark/README.md`

- [ ] **Step 1: Write the README**

Cover: what the benchmark measures (Arabic dialectal retrieval quality across flags); prerequisites (DB + embedder like the playground; optional reranker via `RERANKER_*`; optional judge via `JUDGE_*`; Python + `pip install pypdf` for PDF extraction); the **prep** sequence (`python examples/benchmark/extract_pdfs.py`; scraping is pre-frozen into `datasets/faqs/` + `queries.json`; `bun run examples/benchmark/buildCorpus.ts`); the **run** commands (single config with flags; `--matrix`; `--judge`; `--limit-queries`); how scoring works (target-doc ground truth, Recall@k/MRR/nDCG, dialect/domain slices); the disclosure that FAQ snapshots/PDF text are gitignored and not redistributed; and the `--include-question-in-doc` escape hatch.

- [ ] **Step 2: Verify links/commands match files**

Run: `bun run lint examples/benchmark/README.md` (Biome ignores .md content rules but confirms no tooling error) and manually confirm each referenced path exists.

- [ ] **Step 3: Commit**

```bash
git add examples/benchmark/README.md
git commit -m "docs(benchmark): README (prereqs, prep, run, scoring)"
```

---

## Self-Review

**1. Spec coverage**

- Two-phase prep/run → Tasks 7–10 (prep) + Task 12 (run). ✓
- FAQ corpus (answers) + PDF distractors → Tasks 8, 9. ✓
- MSA/Saudi/Darija variants, target-doc GT, snippet validation → Tasks 3, 10, 12. ✓
- Flags + `--matrix` + embedding cache → Tasks 5, 12. ✓
- Metrics (Recall@k/MRR/nDCG) sliced by dialect/domain → Tasks 2, 12. ✓
- Optional LLM-judge → Task 11. ✓
- Playground-style DB lifecycle / wiring → Task 6, 12. ✓
- Reproducibility/gitignore/no-text-commit → Global Constraints, Tasks 8/9/12. ✓
- Unit tests for pure functions → Tasks 2,3,4,5,11. ✓
- Disclosure of terms/policy corpus nature → Task 12 step 6, Task 13. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N"; copied wiring (Task 6) cites exact playground line ranges + exact export list; integration tasks give exact commands + expected observable output. ✓

**3. Type consistency:** `CorpusChunk`/`FaqRecord`/`BenchmarkQuery`/`QueriesFile` (Task 1) are used identically in Tasks 3, 9, 12; `QueryOutcome` fields (Task 2) match what Task 12 constructs; `withEmbeddingCache` (Task 5) returns `EmbeddingProvider` consumed in Task 12; `resolveQueries` signature (Task 3) matches its Task 10/12 callers; `judgeResults`/`parseJudgeScores` (Task 11) match Task 12 usage. ✓

**Note (spec refinement):** PDF cleaning (boilerplate strip + Arabic-script filter) lives in TS `cleanArabic.ts` (unit-tested), with `extract_pdfs.py` doing only raw pypdf extraction — a split from the spec's §3 (which described cleaning inside the Python step) that makes the cleaning logic testable. Behavior is identical; no spec goal is dropped.
