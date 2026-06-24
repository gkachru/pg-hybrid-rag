# Thai Word-Segmentation RAG Benchmark — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `examples/benchmark-thai/` — a Thai retrieval benchmark whose headline axis is word-segmentation quality (`none` vs `IntlSegmenterAdapter` vs `HttpThaiSegmenter`/attacut), over scraped Thai telecom/banking/insurance FAQs (scored targets) + policy PDFs (distractors), scored by Recall@k / MRR@10 / nDCG@10.

**Architecture:** A near-mirror of `examples/benchmark/` (the Arabic benchmark): isolated DB per config → migrate → seed stop words → index a pre-built corpus → run every (query × register) through `RagPipeline.search` → score → drop. The new axis is the injected `Segmenter`, which only changes `content_normalized` and the lexical query (the dense + rerank legs are a byte-identical control across arms). Reuses the infinity BGE-M3 + bge-reranker-v2-m3 infra and the attacut sidecar already in the repo.

**Tech Stack:** Bun + TypeScript, `postgres` (postgres.js), the `pg-hybrid-rag` library (`../../src/index.js`), the committed `HttpThaiSegmenter` adapter (`examples/nestjs-thai-segmenter.ts`), the committed attacut sidecar (`examples/thai-segmenter/`), Python 3 + pypdf (PDF prep), Playwright MCP (scraping).

**Spec:** `docs/superpowers/specs/2026-06-24-thai-segmentation-benchmark-design.md`

## Global Constraints

- **Runtime:** Bun. Build targets ES2022. Linter: Biome (`bun run lint`). Strict TypeScript, **no `any`**.
- **Testing strategy (repo convention):** `examples/` is **excluded from `tsc --noEmit` and from the mocked `tests/` suite**. Pure, deterministic helpers get **colocated mock-only `*.test.ts`** (precedent: `examples/thai-segmenter/adapter.test.ts`) that `bun test` picks up — these MUST NOT touch the network or a DB. I/O orchestration (`buildCorpus.ts`, `infra.ts` DB paths, `run.ts`, scraping) is gated by **`bun run lint` clean + careful read + a live smoke run**, exactly as the Arabic benchmark and the Thai segmenter example are. Do not invent unit tests for code that needs a live DB/GPU/network.
- **Do NOT modify:** `src/`, `tests/`, `examples/benchmark/` (Arabic), `examples/playground.ts`, or the internals of `examples/thai-segmenter/` and `examples/nestjs-thai-segmenter.ts`. If a real library bug surfaces, report it — do not fix it here.
- **No new SQL migration.** Thai resolves to the `'simple'` FTS config via the existing `rag_fts_config()`; the segmenter is what makes `'simple'` work for Thai.
- **Corpus chunking uses plain `Chunker.chunk()` (no segmenter)** so chunk text — and therefore dense embeddings + reranker input — are byte-identical across the three segmenter arms (the dense leg is a true control). The segmenter is injected into `RagIndexer` + `PostgresRagDatabase` + `RagPipeline` ONLY, never the `Chunker`.
- **`--cjk` is never used** (Thai is not CJK; segmenter + pg_trgm is the keyword path).
- **Embedder:** BGE-M3 (1024-dim) via the existing infinity compose; runtime reads `EMBEDDING_DIM` (set `1024`) and `VECTOR_MIN_SCORE` (set `≈0.4` — the 0.8 default is e5-calibrated and would zero the dense leg for BGE-M3). **Reranker:** `bge-reranker-v2-m3` on the same infinity port.
- **Provider scope (broad, 3×3):** telecom = AIS/True/dtac; banking = SCB/Kasikorn(KBank)/Bangkok Bank; insurance = AIA/Muang Thai/FWD. Target ~250–350 FAQ pairs + ~10–15 policy PDFs. **Yield is uncertain (SPA/403)** — degrade scope gracefully and document drops.
- **Redistribution:** scraped FAQ snapshots (`datasets/faqs-th/`), policy PDFs (`datasets/PDFs-th/`), the cache (`datasets/benchmark-cache-th/`), and `results/` are **gitignored**. Only `queries.json`, `scrape-notes.md`, `README.md`, and the code are committed.
- **All file paths are relative to the repo root** `C:\Users\gauta\code\kochar\pg-hybrid-rag`. Run all `bun`/`git` commands from the repo root.

---

## Phase 1 — Tested pure helpers (no data, no services)

### Task 1: Scaffold directory + types + metrics

**Files:**
- Create: `examples/benchmark-thai/types.ts`
- Create: `examples/benchmark-thai/metrics.ts`
- Test: `examples/benchmark-thai/metrics.test.ts`

**Interfaces:**
- Produces: `Register = "written"|"spoken"|"codeswitch"`, `Domain = "telecom"|"banking"|"insurance"`, `FaqRecord`, `ExtractedPdf`, `CorpusChunk`, `BenchmarkQuery`, `QueriesFile`; metric fns `recallAtK`, `reciprocalRank`, `ndcgAtK`, `summarize`, `sliceBy`, types `QueryOutcome` (with `register` + `loanword`), `MetricSummary`.

- [ ] **Step 1: Create `types.ts`**

```ts
export type Register = "written" | "spoken" | "codeswitch";
export type Domain = "telecom" | "banking" | "insurance";

/** One scraped FAQ pair. doc_id = "faq:<provider>:<ordinal>". */
export interface FaqRecord {
  doc_id: string;
  domain: Domain;
  provider: string;
  question: string;
  answer: string;
}

/** Raw pypdf extraction for one policy/T&C PDF. doc_id = "pdf:<provider>:<ordinal>". */
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

/** A scored query with three register variants sharing one target document. */
export interface BenchmarkQuery {
  id: string;
  domain: Domain;
  provider: string;
  target_doc: string;
  target_snippet: string;
  variants: Record<Register, string>;
}

export interface QueriesFile {
  version: number;
  queries: BenchmarkQuery[];
}
```

- [ ] **Step 2: Create `metrics.ts`** (Arabic `metrics.ts` with `Dialect`→`Register` and a `loanword` field on `QueryOutcome`)

```ts
import type { Register } from "./types.js";

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
  register: Register;
  domain: string;
  provider: string;
  loanword: boolean;
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
    n: 0,
    recallAt1: 0,
    recallAt3: 0,
    recallAt5: 0,
    recallAt10: 0,
    mrr10: 0,
    ndcg10: 0,
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

- [ ] **Step 3: Write `metrics.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { ndcgAtK, recallAtK, reciprocalRank, sliceBy, summarize, type QueryOutcome } from "./metrics";

const oc = (ranked: string[], target: string, over: Partial<QueryOutcome> = {}): QueryOutcome => ({
  rankedDocIds: ranked,
  targetDoc: target,
  register: "written",
  domain: "telecom",
  provider: "ais",
  loanword: false,
  source: "faq",
  ...over,
});

describe("metrics", () => {
  test("recallAtK: hit within k vs outside k", () => {
    expect(recallAtK(["a", "b", "c"], "c", 3)).toBe(1);
    expect(recallAtK(["a", "b", "c"], "c", 2)).toBe(0);
  });
  test("reciprocalRank: 1/(rank+1), 0 if absent", () => {
    expect(reciprocalRank(["a", "b"], "b")).toBe(0.5);
    expect(reciprocalRank(["a"], "z")).toBe(0);
  });
  test("ndcgAtK: 1/log2(idx+2)", () => {
    expect(ndcgAtK(["x", "t"], "t")).toBeCloseTo(1 / Math.log2(3));
  });
  test("summarize: averages and counts", () => {
    const m = summarize([oc(["t"], "t"), oc(["x"], "t")]);
    expect(m.n).toBe(2);
    expect(m.recallAt1).toBe(0.5);
  });
  test("summarize: empty → zeros", () => {
    expect(summarize([]).n).toBe(0);
  });
  test("sliceBy register groups", () => {
    const g = sliceBy(
      [oc(["t"], "t", { register: "written" }), oc(["t"], "t", { register: "spoken" })],
      (o) => o.register,
    );
    expect([...g.keys()].sort()).toEqual(["spoken", "written"]);
  });
});
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `bun test examples/benchmark-thai/metrics.test.ts`
Expected: all tests pass (6 in `metrics`).

- [ ] **Step 5: Lint + commit**

```bash
bun run lint
git add examples/benchmark-thai/types.ts examples/benchmark-thai/metrics.ts examples/benchmark-thai/metrics.test.ts
git commit -m "feat(benchmark-thai): types + metrics (register slices)"
```

---

### Task 2: Loanword cross-cut tagger

**Files:**
- Create: `examples/benchmark-thai/loanword.ts`
- Test: `examples/benchmark-thai/loanword.test.ts`

**Interfaces:**
- Produces: `isLoanwordHeavy(text: string): boolean`.

- [ ] **Step 1: Write `loanword.test.ts` (failing — module not created yet)**

```ts
import { describe, expect, test } from "bun:test";
import { isLoanwordHeavy } from "./loanword";

describe("isLoanwordHeavy", () => {
  test("Latin-script run (code-switch / brand) → true", () => {
    expect(isLoanwordHeavy("เปิด international roaming ยังไง")).toBe(true);
  });
  test("brand with adjacent digit (5G) → true", () => {
    expect(isLoanwordHeavy("สมัครเน็ต 5G ยังไง")).toBe(true);
  });
  test("Thai-script transliteration → true", () => {
    expect(isLoanwordHeavy("เปิดโรมมิ่งต่างประเทศยังไง")).toBe(true);
  });
  test("pure native Thai → false", () => {
    expect(isLoanwordHeavy("จะเปิดใช้บริการข้ามแดนได้อย่างไร")).toBe(false);
  });
  test("single stray Latin letter is not a run → false", () => {
    expect(isLoanwordHeavy("ค่าบริการ A")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test examples/benchmark-thai/loanword.test.ts`
Expected: FAIL — `Cannot find module './loanword'`.

- [ ] **Step 3: Write `loanword.ts`**

```ts
/**
 * Heuristic loanword/OOV detector for the loanword cross-cut slice. A Thai query is
 * "loanword-heavy" if it contains a Latin-script run (code-switched / brand token, incl.
 * letter+digit forms like "5G") OR any known Thai-script transliteration of a foreign term.
 * Deterministic and intentionally coarse — it labels the slice on which a neural segmenter
 * (attacut) is expected to beat a dictionary segmenter, not a linguistic ground truth.
 */
const TRANSLITERATIONS = [
  "โรมมิ่ง",
  "แพ็กเกจ",
  "แพคเกจ",
  "อินเทอร์เน็ต",
  "เน็ต",
  "ดาต้า",
  "ซิม",
  "ออนไลน์",
  "แอป",
  "แอพ",
  "เครดิต",
  "เดบิต",
  "บาลานซ์",
  "ไฟเบอร์",
  "วายฟาย",
  "บลูทูธ",
  "พรีเมียม",
  "โบนัส",
  "แคชแบ็ก",
  "พอยต์",
];

/** A run of >=2 Latin letters, or a Latin letter adjacent to a digit (e.g. "5G", "4K"). */
const LATIN_OR_BRAND = /[A-Za-z]{2,}|\d[A-Za-z]|[A-Za-z]\d/;

export function isLoanwordHeavy(text: string): boolean {
  if (LATIN_OR_BRAND.test(text)) return true;
  return TRANSLITERATIONS.some((t) => text.includes(t));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test examples/benchmark-thai/loanword.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint + commit**

```bash
bun run lint
git add examples/benchmark-thai/loanword.ts examples/benchmark-thai/loanword.test.ts
git commit -m "feat(benchmark-thai): loanword-heavy query tagger"
```

---

### Task 3: Thai-script PDF cleaner

**Files:**
- Create: `examples/benchmark-thai/cleanThai.ts`
- Test: `examples/benchmark-thai/cleanThai.test.ts`

**Interfaces:**
- Produces: `thaiRatio(text)`, `isThaiDominant(text, threshold?)`, `stripRecurringBoilerplate(pages, minFraction?)`, `cleanThaiDoc(pages, threshold?)`.

- [ ] **Step 1: Write `cleanThai.test.ts` (failing)**

```ts
import { describe, expect, test } from "bun:test";
import { cleanThaiDoc, isThaiDominant, stripRecurringBoilerplate, thaiRatio } from "./cleanThai";

describe("cleanThai", () => {
  test("thaiRatio: pure Thai = 1", () => {
    expect(thaiRatio("นโยบาย")).toBe(1);
  });
  test("isThaiDominant: Thai line with a brand token stays dominant", () => {
    expect(isThaiDominant("เปิดบริการโรมมิ่ง 5G ระหว่างประเทศ")).toBe(true);
  });
  test("isThaiDominant: mostly-Latin line is not dominant", () => {
    expect(isThaiDominant("Terms and Conditions apply ก")).toBe(false);
  });
  test("thaiRatio: digits are not letters", () => {
    expect(thaiRatio("12345")).toBe(0);
  });
  test("stripRecurringBoilerplate drops lines recurring on >= half the pages", () => {
    const pages = ["HEADER\nเนื้อหา ก", "HEADER\nเนื้อหา ข", "HEADER\nเนื้อหา ค"];
    const out = stripRecurringBoilerplate(pages);
    expect(out.join("\n")).not.toContain("HEADER");
    expect(out.join("\n")).toContain("เนื้อหา");
  });
  test("cleanThaiDoc keeps Thai-dominant lines, drops Latin boilerplate", () => {
    const doc = cleanThaiDoc([
      "Copyright 2026\nนโยบายความเป็นส่วนตัว",
      "Copyright 2026\nการคืนเงิน",
    ]);
    expect(doc).toContain("นโยบาย");
    expect(doc).not.toContain("Copyright");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test examples/benchmark-thai/cleanThai.test.ts`
Expected: FAIL — `Cannot find module './cleanThai'`.

- [ ] **Step 3: Write `cleanThai.ts`** (structure mirrors `examples/benchmark/cleanArabic.ts`; Thai letters 0x0E01–0x0E4E; Latin counts as a non-Thai letter so brand tokens lower the ratio but don't disqualify a Thai-dominant line)

```ts
/** Fraction of letter characters that are Thai (0 if no letters). Latin counts as a non-Thai
 *  letter so brand tokens lower the ratio slightly but don't disqualify a Thai-dominant line.
 *  Digits/punctuation are not letters and don't affect the ratio. */
export function thaiRatio(text: string): number {
  let thai = 0;
  let letters = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Thai consonants + vowels + tone marks (excludes Thai digits 0x0E50-0x0E59 and symbols).
    const isThai = code >= 0x0e01 && code <= 0x0e4e;
    const isLatin = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (isThai || isLatin) letters++;
    if (isThai) thai++;
  }
  return letters === 0 ? 0 : thai / letters;
}

export function isThaiDominant(text: string, threshold = 0.5): boolean {
  return thaiRatio(text) >= threshold;
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
    page
      .split("\n")
      .filter((raw) => !boilerplate.has(raw.trim()))
      .join("\n"),
  );
}

/**
 * Clean a multi-page PDF extraction into Thai-dominant text: strip recurring boilerplate,
 * keep Thai-dominant lines (brand tokens preserved within them), join with newlines.
 */
export function cleanThaiDoc(pages: string[], threshold = 0.5): string {
  const stripped = stripRecurringBoilerplate(pages);
  const kept: string[] = [];
  for (const page of stripped) {
    for (const raw of page.split("\n")) {
      const line = raw.trim();
      if (line && isThaiDominant(line, threshold)) kept.push(line);
    }
  }
  return kept.join("\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test examples/benchmark-thai/cleanThai.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint + commit**

```bash
bun run lint
git add examples/benchmark-thai/cleanThai.ts examples/benchmark-thai/cleanThai.test.ts
git commit -m "feat(benchmark-thai): Thai-script PDF cleaner"
```

---

### Task 4: Query resolution (qrels)

**Files:**
- Create: `examples/benchmark-thai/qrels.ts`
- Test: `examples/benchmark-thai/qrels.test.ts`

**Interfaces:**
- Consumes: `BenchmarkQuery`, `QueriesFile` from `./types.js`.
- Produces: `loadQueries(path): QueriesFile`, `resolveQueries(queries, corpusDocIds): { resolved, unresolved }`, `snippetPresent(snippet, docText, normalize): boolean`.

- [ ] **Step 1: Write `qrels.ts`** (identical to `examples/benchmark/qrels.ts`; types come from the Thai `types.ts`)

```ts
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

- [ ] **Step 2: Write `qrels.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { resolveQueries, snippetPresent } from "./qrels";
import type { BenchmarkQuery } from "./types";

const q = (id: string, target: string): BenchmarkQuery => ({
  id,
  domain: "telecom",
  provider: "ais",
  target_doc: target,
  target_snippet: "x",
  variants: { written: "ก", spoken: "ก", codeswitch: "ก" },
});

describe("qrels", () => {
  test("resolveQueries partitions by corpus membership", () => {
    const { resolved, unresolved } = resolveQueries(
      [q("a", "faq:ais:1"), q("b", "faq:x:9")],
      new Set(["faq:ais:1"]),
    );
    expect(resolved.map((r) => r.id)).toEqual(["a"]);
    expect(unresolved.map((r) => r.id)).toEqual(["b"]);
  });
  test("snippetPresent applies the normalizer to both sides", () => {
    expect(snippetPresent("ABC", "xx abc yy", (s) => s.toLowerCase())).toBe(true);
    expect(snippetPresent("zzz", "abc", (s) => s)).toBe(false);
  });
});
```

- [ ] **Step 3: Run — expect PASS**

Run: `bun test examples/benchmark-thai/qrels.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Lint + commit**

```bash
bun run lint
git add examples/benchmark-thai/qrels.ts examples/benchmark-thai/qrels.test.ts
git commit -m "feat(benchmark-thai): query resolution (qrels)"
```

---

### Task 5: LLM judge (Thai prompt)

**Files:**
- Create: `examples/benchmark-thai/judge.ts`
- Test: `examples/benchmark-thai/judge.test.ts`

**Interfaces:**
- Produces: `JudgeConfig`, `judgeEnabledFromEnv(): JudgeConfig | undefined`, `parseJudgeScores(raw, n): number[]`, `judgeResults(query, results, cfg): Promise<number[]>`.

- [ ] **Step 1: Write `judge.ts`** (identical to `examples/benchmark/judge.ts` except the prompt is Thai)

```ts
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
    `คำถามของผู้ใช้: "${query}"\n` +
    `ให้คะแนนความเกี่ยวข้องของแต่ละข้อความกับคำถาม: 0 (ไม่เกี่ยวข้อง), 1 (เกี่ยวข้องบางส่วน), 2 (ตอบคำถามได้)\n` +
    `ตอบเป็นตัวเลขเท่านั้น เรียงตามลำดับ คั่นด้วยเครื่องหมายจุลภาค\n${blocks}`;
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

- [ ] **Step 2: Write `judge.test.ts`** (parse-only — no network)

```ts
import { describe, expect, test } from "bun:test";
import { parseJudgeScores } from "./judge";

describe("parseJudgeScores", () => {
  test("extracts 0/1/2 in order and pads to n", () => {
    expect(parseJudgeScores("2, 0, 1", 4)).toEqual([2, 0, 1, 0]);
  });
  test("truncates to n", () => {
    expect(parseJudgeScores("1 1 1 1 1", 2)).toEqual([1, 1]);
  });
  test("ignores surrounding Thai text", () => {
    expect(parseJudgeScores("คะแนน: 2 และ 1", 2)).toEqual([2, 1]);
  });
});
```

- [ ] **Step 3: Run — expect PASS**

Run: `bun test examples/benchmark-thai/judge.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Lint + commit**

```bash
bun run lint
git add examples/benchmark-thai/judge.ts examples/benchmark-thai/judge.test.ts
git commit -m "feat(benchmark-thai): LLM judge with Thai prompt"
```

---

## Phase 2 — Infra, corpus build, runner (lint + read gated)

### Task 6: Infra + embedding cache + segmenter factory

**Files:**
- Create: `examples/benchmark-thai/embeddingCache.ts`
- Create: `examples/benchmark-thai/infra.ts`
- Test: `examples/benchmark-thai/infra.test.ts`

**Interfaces:**
- Consumes: `HttpThaiSegmenter` from `../nestjs-thai-segmenter.js` (type-only `Segmenter` import in that file is erased at runtime; the example is excluded from typecheck — this is the same pattern `examples/thai-segmenter/smoke.ts` uses).
- Produces: `buildDatabaseUrl`, `withDatabase`, `createDatabase`, `dropDatabase`, `createAdapter`, `createEmbedder`, `createReranker`, `logger`, `TENANT_ID`, **`SegmenterKind = "none"|"intl"|"attacut"`**, **`createSegmenter(kind): Segmenter | undefined`**; `withEmbeddingCache` (re-exported via its own module).

- [ ] **Step 1: Copy the embedding cache verbatim**

`examples/benchmark/embeddingCache.ts` is language-agnostic. Copy it byte-for-byte to `examples/benchmark-thai/embeddingCache.ts` (no edits).

```bash
cp examples/benchmark/embeddingCache.ts examples/benchmark-thai/embeddingCache.ts
```

- [ ] **Step 2: Copy the Arabic infra as the base**

```bash
cp examples/benchmark/infra.ts examples/benchmark-thai/infra.ts
```

- [ ] **Step 3: Edit the top import block in `infra.ts`** to pull in `IntlSegmenterAdapter`, the `Segmenter` type, and the `HttpThaiSegmenter` adapter.

Replace:

```ts
import postgres from "postgres";
import {
  type EmbeddingProvider,
  OpenAiCompatibleEmbedder,
  type RagResult,
  type RerankerProvider,
  type SqlClient,
  type TransactionProvider,
} from "../../src/index.js";
```

with:

```ts
import postgres from "postgres";
import {
  type EmbeddingProvider,
  IntlSegmenterAdapter,
  OpenAiCompatibleEmbedder,
  type RagResult,
  type RerankerProvider,
  type Segmenter,
  type SqlClient,
  type TransactionProvider,
} from "../../src/index.js";
import { HttpThaiSegmenter } from "../nestjs-thai-segmenter.js";
```

- [ ] **Step 4: Add the segmenter factory** at the end of `infra.ts` (after the `TENANT_ID` constant)

```ts
// ── Segmenter factory (the headline axis) ────────────────────────────────────
// "none"   → undefined (unsegmented Thai: FTS 'simple' sees ~one giant token; pg_trgm
//             survives on character trigrams) — the intended degraded baseline.
// "intl"   → stdlib ICU IntlSegmenterAdapter (dictionary; shreds OOV/loanwords).
// "attacut"→ HttpThaiSegmenter against the sidecar (neural; learns OOV boundaries).
export type SegmenterKind = "none" | "intl" | "attacut";

export function createSegmenter(kind: SegmenterKind): Segmenter | undefined {
  if (kind === "none") return undefined;
  if (kind === "intl") return new IntlSegmenterAdapter({ languages: ["th"] });
  const baseUrl = process.env.THAI_SEGMENTER_URL ?? "http://localhost:8100";
  return new HttpThaiSegmenter({ baseUrl });
}
```

- [ ] **Step 5: Write `infra.test.ts`** (the factory is pure — no DB/network; `HttpThaiSegmenter`'s constructor only stores config)

```ts
import { describe, expect, test } from "bun:test";
import { createSegmenter } from "./infra";

describe("createSegmenter", () => {
  test("none → undefined", () => {
    expect(createSegmenter("none")).toBeUndefined();
  });
  test("intl → segments Thai, passes through English", () => {
    const s = createSegmenter("intl");
    expect(s?.segmentsLanguage("th")).toBe(true);
    expect(s?.segmentsLanguage("en")).toBe(false);
  });
  test("attacut → handles th / th-TH", () => {
    const s = createSegmenter("attacut");
    expect(s?.segmentsLanguage("th-TH")).toBe(true);
    expect(s?.segmentsLanguage("zh")).toBe(false);
  });
});
```

- [ ] **Step 6: Run the factory test — expect PASS**

Run: `bun test examples/benchmark-thai/infra.test.ts`
Expected: PASS (3 tests). If it errors on the `../nestjs-thai-segmenter.js` import, confirm the file exists and that only a *type* import of `Segmenter` is present there (it is — runtime-erased).

- [ ] **Step 7: Lint + commit**

```bash
bun run lint
git add examples/benchmark-thai/embeddingCache.ts examples/benchmark-thai/infra.ts examples/benchmark-thai/infra.test.ts
git commit -m "feat(benchmark-thai): infra + embedding cache + segmenter factory"
```

---

### Task 7: PDF extraction + corpus builder

**Files:**
- Create: `examples/benchmark-thai/extract_pdfs.py`
- Create: `examples/benchmark-thai/buildCorpus.ts`

**Interfaces:**
- Consumes: `Chunker` from `../../src/index.js`; `cleanThaiDoc` from `./cleanThai.js`; `CorpusChunk`, `ExtractedPdf`, `FaqRecord` from `./types.js`.
- Produces: `buildCorpus(includeQuestion?): CorpusChunk[]`, `loadOrBuildCorpus(includeQuestion?): CorpusChunk[]`. Reads `datasets/faqs-th/*.jsonl` + `datasets/benchmark-cache-th/extracted.jsonl`; writes `datasets/benchmark-cache-th/corpus.jsonl` (or `corpus-withq.jsonl`).

> No unit test (matches the Arabic `buildCorpus.ts`, which is untested I/O orchestration over the library `Chunker`). Gate: `bun run lint` + careful read; exercised live in Task 11.

- [ ] **Step 1: Write `extract_pdfs.py`** (Thai paths; provider→domain map for the 9 candidate providers; filename convention `<provider>_<freeform>.pdf`)

```python
# examples/benchmark-thai/extract_pdfs.py
"""Raw per-page text extraction for the Thai RAG benchmark.
Cleaning (boilerplate strip + Thai-script filter) happens in TS (cleanThai.ts);
this script only extracts text with pypdf.
Filename convention: <provider>_<freeform>.pdf  (e.g. ais_roaming_terms.pdf).
Usage: python examples/benchmark-thai/extract_pdfs.py
"""
import json
import os
import sys
from pypdf import PdfReader

PDF_DIR = os.path.join("datasets", "PDFs-th")
OUT_DIR = os.path.join("datasets", "benchmark-cache-th")
OUT = os.path.join(OUT_DIR, "extracted.jsonl")

DOMAIN_BY_PROVIDER = {
    "ais": "telecom",
    "true": "telecom",
    "dtac": "telecom",
    "scb": "banking",
    "kbank": "banking",
    "bbl": "banking",
    "aia": "insurance",
    "muangthai": "insurance",
    "fwd": "insurance",
}

def classify(filename: str):
    stem = os.path.splitext(filename)[0]
    provider = stem.split("_")[0].lower()
    domain = DOMAIN_BY_PROVIDER.get(provider, "telecom")
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

- [ ] **Step 2: Write `buildCorpus.ts`** (Arabic `buildCorpus.ts` with Thai paths, `cleanThaiDoc`, `language: "th"`)

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chunker } from "../../src/index.js";
import { cleanThaiDoc } from "./cleanThai.js";
import type { CorpusChunk, ExtractedPdf, FaqRecord } from "./types.js";

const FAQ_DIR = join("datasets", "faqs-th");
const CACHE_DIR = join("datasets", "benchmark-cache-th");
const EXTRACTED = join(CACHE_DIR, "extracted.jsonl");
// Two corpus variants, kept as SEPARATE files so building one never overwrites the other:
//   corpus.jsonl        — FAQ answer only (default)
//   corpus-withq.jsonl  — FAQ question + answer (raises lexical overlap with the query)
const CORPUS_ANSWER_ONLY = join(CACHE_DIR, "corpus.jsonl");
const CORPUS_WITH_QUESTION = join(CACHE_DIR, "corpus-withq.jsonl");
const corpusPath = (includeQuestion: boolean): string =>
  includeQuestion ? CORPUS_WITH_QUESTION : CORPUS_ANSWER_ONLY;

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const results: T[] = [];
  for (const l of readFileSync(path, "utf8").trim().split("\n")) {
    if (l.length === 0) continue;
    try {
      results.push(JSON.parse(l) as T);
    } catch {
      console.warn(`skipping malformed line in ${path}`);
    }
  }
  return results;
}

export function buildCorpus(includeQuestion = false): CorpusChunk[] {
  // Plain chunk() (no segmenter) so chunk text — and therefore the dense embeddings — are
  // identical across all segmenter arms; the dense leg is the control. The segmenter axis is
  // applied later at INDEX time (content_normalized) by RagIndexer, not here.
  const chunker = new Chunker({ tokenLimit: 512, overlap: 75 });
  const out: CorpusChunk[] = [];

  // FAQ answers (scored targets)
  const faqFiles = existsSync(FAQ_DIR)
    ? readdirSync(FAQ_DIR).filter((f) => f.endsWith(".jsonl"))
    : [];
  for (const file of faqFiles) {
    for (const rec of readJsonl<FaqRecord>(join(FAQ_DIR, file))) {
      const content = includeQuestion ? `${rec.question}\n${rec.answer}` : rec.answer;
      for (const chunk of chunker.chunk(content, { language: "th" })) {
        out.push({
          chunk_id: `${rec.doc_id}#${chunk.index}`,
          doc_id: rec.doc_id,
          source: "faq",
          domain: rec.domain,
          provider: rec.provider,
          language: "th",
          content: chunk.content,
        });
      }
    }
  }

  // Policy/T&C PDF distractors
  for (const pdf of readJsonl<ExtractedPdf>(EXTRACTED)) {
    const text = cleanThaiDoc(pdf.pages);
    if (!text.trim()) continue;
    for (const chunk of chunker.chunk(text, { language: "th" })) {
      out.push({
        chunk_id: `${pdf.doc_id}#${chunk.index}`,
        doc_id: pdf.doc_id,
        source: "pdf",
        domain: pdf.domain,
        provider: pdf.provider,
        language: "th",
        content: chunk.content,
      });
    }
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const path = corpusPath(includeQuestion);
  writeFileSync(path, `${out.map((c) => JSON.stringify(c)).join("\n")}\n`, "utf8");
  const bySource = (s: string) => out.filter((c) => c.source === s).length;
  console.log(
    `corpus (${includeQuestion ? "question+answer" : "answer-only"}) -> ${path}: ` +
      `${out.length} chunks (faq=${bySource("faq")}, pdf=${bySource("pdf")})`,
  );
  return out;
}

export function loadOrBuildCorpus(includeQuestion = false): CorpusChunk[] {
  const path = corpusPath(includeQuestion);
  if (existsSync(path)) return readJsonl<CorpusChunk>(path);
  return buildCorpus(includeQuestion);
}

if (import.meta.main) {
  buildCorpus(process.argv.includes("--include-question"));
}
```

- [ ] **Step 3: Lint + verify `buildCorpus.ts` imports resolve (no run yet — no data)**

Run: `bun run lint`
Run: `bun -e "import('./examples/benchmark-thai/buildCorpus.ts').then(()=>console.log('imports ok'))"`
Expected: `imports ok` (proves the module + its `../../src/index.js` and `./cleanThai.js` imports load; `buildCorpus` is not called, so absent data is fine).

- [ ] **Step 4: Commit**

```bash
git add examples/benchmark-thai/extract_pdfs.py examples/benchmark-thai/buildCorpus.ts
git commit -m "feat(benchmark-thai): pypdf extraction + plain-chunk corpus builder"
```

---

### Task 8: Benchmark runner (`run.ts`)

**Files:**
- Create: `examples/benchmark-thai/run.ts`

**Interfaces:**
- Consumes: everything above + the library (`Bm25Fts`, `CachingStopWordsLoader`, `LanguageNormalizer`, `normalizeForLanguage`, `PostgresRagDatabase`, `RagIndexer`, `RagPipeline`, `ragMigrate`).
- Produces: a CLI (`bun run examples/benchmark-thai/run.ts [...flags]`) that writes `examples/benchmark-thai/results/<ts>.json`.

> Gate: `bun run lint` + careful read here; full live run is Task 14.

- [ ] **Step 1: Copy the Arabic runner as the base**

```bash
cp examples/benchmark/run.ts examples/benchmark-thai/run.ts
```

- [ ] **Step 2: Replace the file docstring + import block.**

Replace lines from the top `/** ... */` docstring through the `import type { BenchmarkQuery, CorpusChunk, Dialect } from "./types.js";` line with:

```ts
/**
 * Thai segmentation benchmark runner — runs LIVE against a real Postgres + embedding API.
 *
 * Headline axis: word segmentation. For each config (a `custom` config, the 5 `--matrix`
 * presets with attacut fixed, or the `--seg-matrix` sweep of {none,intl,attacut}×{baseline,
 * +rerank}), it creates an isolated database, migrates it (optional bm25/vectorchord; NEVER
 * cjk), seeds Thai stop words, indexes the pre-built corpus with the arm's segmenter, runs
 * every resolved query × its three register variants through RagPipeline.search, scores, then
 * drops the DB. Prints per-config tables + a cross-config (cross-segmenter) comparison and a
 * results JSON.
 *
 * Usage:
 *   bun run examples/benchmark-thai/run.ts                          # single baseline (attacut)
 *   bun run examples/benchmark-thai/run.ts --segmenter none         # single arm
 *   bun run examples/benchmark-thai/run.ts --seg-matrix             # headline: 3 segmenters × {baseline,+rerank}
 *   bun run examples/benchmark-thai/run.ts --matrix                 # 5 extension configs (attacut fixed)
 *   bun run examples/benchmark-thai/run.ts --seg-matrix --limit-queries 6 --judge
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  Bm25Fts,
  CachingStopWordsLoader,
  LanguageNormalizer,
  normalizeForLanguage,
  PostgresRagDatabase,
  RagIndexer,
  RagPipeline,
  ragMigrate,
} from "../../src/index.js";
import { loadOrBuildCorpus } from "./buildCorpus.js";
import { withEmbeddingCache } from "./embeddingCache.js";
import {
  buildDatabaseUrl,
  createAdapter,
  createDatabase,
  createEmbedder,
  createReranker,
  createSegmenter,
  dropDatabase,
  logger,
  type SegmenterKind,
  TENANT_ID,
  withDatabase,
} from "./infra.js";
import { judgeEnabledFromEnv, judgeResults } from "./judge.js";
import { isLoanwordHeavy } from "./loanword.js";
import { type MetricSummary, type QueryOutcome, sliceBy, summarize } from "./metrics.js";
import { loadQueries, resolveQueries, snippetPresent } from "./qrels.js";
import type { BenchmarkQuery, CorpusChunk, Register } from "./types.js";
```

- [ ] **Step 3: Replace the config block** (`BenchConfig` interface through `const DIALECTS`).

Replace the `interface BenchConfig { ... }`, `const MATRIX`, `const DIALECTS`, the `LEAN_MATRIX` comment + const with:

```ts
interface BenchConfig {
  name: string;
  bm25: boolean;
  vectorchord: boolean;
  rerank: boolean;
  segmenter: SegmenterKind;
}

// Standard extension matrix — segmenter fixed to attacut (production default). Answers
// "do bm25 / vectorchord / rerank add value on Thai?" independent of the segmenter axis.
const MATRIX: BenchConfig[] = [
  { name: "baseline", bm25: false, vectorchord: false, rerank: false, segmenter: "attacut" },
  { name: "+bm25", bm25: true, vectorchord: false, rerank: false, segmenter: "attacut" },
  { name: "+vectorchord", bm25: false, vectorchord: true, rerank: false, segmenter: "attacut" },
  { name: "+rerank", bm25: false, vectorchord: false, rerank: true, segmenter: "attacut" },
  { name: "all", bm25: true, vectorchord: true, rerank: true, segmenter: "attacut" },
];

const REGISTERS: Register[] = ["written", "spoken", "codeswitch"];

// Headline segmenter sweep: {none,intl,attacut} × {baseline,+rerank}. Mirrors the Arabic
// LEAN_MATRIX philosophy — only the configs that distinguish the axis of interest. The
// +rerank rows show whether the segmenter-blind cross-encoder can paper over a worse segmenter.
const SEG_KINDS: SegmenterKind[] = ["none", "intl", "attacut"];
const SEG_MATRIX: BenchConfig[] = SEG_KINDS.flatMap((seg) => [
  { name: `baseline/${seg}`, bm25: false, vectorchord: false, rerank: false, segmenter: seg },
  { name: `+rerank/${seg}`, bm25: false, vectorchord: false, rerank: true, segmenter: seg },
]);
```

- [ ] **Step 4: Replace the `Args` interface + `parseArgs`** (drop `cjk`; add `segmenter` + `segMatrix`).

Replace the `interface Args { ... }` and `function parseArgs(...) { ... }` with:

```ts
interface Args {
  bm25: boolean;
  vectorchord: boolean;
  rerank: boolean;
  segmenter: SegmenterKind;
  judge: boolean;
  matrix: boolean;
  segMatrix: boolean;
  topK: number;
  limitQueries?: number;
  includeQuestion: boolean;
}

function parseArgs(argv: string[]): Args {
  const has = (flag: string) => argv.includes(flag);
  const numAfter = (flag: string): number | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) return undefined;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) ? n : undefined;
  };
  const strAfter = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 || i + 1 >= argv.length ? undefined : argv[i + 1];
  };
  const seg = strAfter("--segmenter");
  const segmenter: SegmenterKind = seg === "none" || seg === "intl" ? seg : "attacut";
  return {
    bm25: has("--bm25"),
    vectorchord: has("--vectorchord"),
    rerank: has("--rerank"),
    segmenter,
    judge: has("--judge"),
    matrix: has("--matrix"),
    segMatrix: has("--seg-matrix"),
    topK: numAfter("--topk") ?? 10,
    limitQueries: numAfter("--limit-queries"),
    includeQuestion: has("--include-question"),
  };
}
```

- [ ] **Step 5: Replace the `ConfigResult` interface** (cjk→segmenter; byDialect→byRegister; add byLoanword).

Replace `interface ConfigResult { ... }` with:

```ts
interface ConfigResult {
  name: string;
  flags: { bm25: boolean; vectorchord: boolean; rerank: boolean; segmenter: SegmenterKind };
  status: "ok" | "failed";
  error?: string;
  overall?: MetricSummary;
  byRegister?: Record<string, MetricSummary>;
  byDomain?: Record<string, MetricSummary>;
  byLoanword?: Record<string, MetricSummary>;
}
```

- [ ] **Step 6: Replace `printDisclosure`** (Thai note).

Replace the whole `function printDisclosure(...) { ... }` body's final `console.log("  Note: ...")` call (keep everything above it) — i.e. replace:

```ts
  console.log(
    "  Note: the corpus is terms/policy (PDF distractors) + FAQ content. Scored targets are FAQ\n" +
      "  answers; PDFs act as in-domain distractors. Queries are Arabic in three dialects (MSA,\n" +
      "  Saudi, Darija) sharing one target FAQ per query.",
  );
```

with:

```ts
  console.log(
    "  Note: the corpus is policy/T&C (PDF distractors) + FAQ content. Scored targets are FAQ\n" +
      "  answers; PDFs act as in-domain distractors. Queries are Thai in three registers (written,\n" +
      "  spoken, code-switched) sharing one target FAQ per query. Headline axis: word segmenter.",
  );
```

- [ ] **Step 7: Replace `printComparison`** (dialect→register; add a per-segmenter framing and a loanword row).

Replace the whole `function printComparison(results: ConfigResult[]): void { ... }` with:

```ts
function printComparison(results: ConfigResult[]): void {
  console.log(`\n${"═".repeat(80)}`);
  console.log("CONFIG COMPARISON (overall, all registers) — segmenter is the headline axis");
  console.log(`${"─".repeat(80)}`);
  console.log(
    `  ${"config".padEnd(18)} ${"R@1".padStart(6)} ${"R@3".padStart(6)} ${"R@5".padStart(6)} ` +
      `${"R@10".padStart(6)} ${"MRR10".padStart(6)} ${"nDCG".padStart(6)}`,
  );
  for (const r of results) {
    if (r.status !== "ok" || !r.overall) {
      console.log(`  ${r.name.padEnd(18)} FAILED — ${r.error ?? "unknown error"}`);
      continue;
    }
    const m = r.overall;
    console.log(
      `  ${r.name.padEnd(18)} ${pct(m.recallAt1)} ${pct(m.recallAt3)} ${pct(m.recallAt5)} ` +
        `${pct(m.recallAt10)} ${f3(m.mrr10)} ${f3(m.ndcg10)}`,
    );
  }

  console.log(`\n  recall@5 by register`);
  console.log(`  ${"config".padEnd(18)} ${REGISTERS.map((d) => d.padStart(10)).join(" ")}`);
  for (const r of results) {
    if (r.status !== "ok" || !r.byRegister) continue;
    const cells = REGISTERS.map((d) => {
      const m = r.byRegister?.[d];
      return (m ? `${(m.recallAt5 * 100).toFixed(1)}%` : "—").padStart(10);
    });
    console.log(`  ${r.name.padEnd(18)} ${cells.join(" ")}`);
  }

  console.log(`\n  recall@5 by loanword slice (the OOV signal)`);
  console.log(`  ${"config".padEnd(18)} ${"loanword".padStart(10)} ${"native".padStart(10)}`);
  for (const r of results) {
    if (r.status !== "ok" || !r.byLoanword) continue;
    const cell = (key: string) => {
      const m = r.byLoanword?.[key];
      return (m ? `${(m.recallAt5 * 100).toFixed(1)}%` : "—").padStart(10);
    };
    console.log(`  ${r.name.padEnd(18)} ${cell("loanword")} ${cell("native")}`);
  }
  console.log(`${"═".repeat(80)}`);
}
```

- [ ] **Step 8: Update `RunOneResult`** — no shape change needed; leave it. **Replace `runConfig`'s signature and body.**

Replace the entire `async function runConfig(...) : Promise<RunOneResult> { ... }` (from its signature down to its closing brace, i.e. the function ending with the `catch` block) with:

```ts
async function runConfig(
  config: BenchConfig,
  topK: number,
  adminUrl: string,
  corpus: CorpusChunk[],
  docOrder: Array<{ doc_id: string; source: string; chunks: CorpusChunk[] }>,
  queries: BenchmarkQuery[],
  docIdByUuid: Map<string, string>,
  embedder: ReturnType<typeof withEmbeddingCache>,
  reranker: ReturnType<typeof createReranker>,
  keepForJudge: boolean,
  createdDbs: Set<string>,
): Promise<RunOneResult> {
  const dbName = `thrag_bench_${config.name.replace(/[^a-z0-9]/g, "")}`;
  const result: ConfigResult = {
    name: config.name,
    flags: {
      bm25: config.bm25,
      vectorchord: config.vectorchord,
      rerank: config.rerank,
      segmenter: config.segmenter,
    },
    status: "ok",
  };

  console.log(`\n${"#".repeat(80)}`);
  console.log(
    `# CONFIG "${config.name}" — segmenter=${config.segmenter} bm25=${config.bm25} ` +
      `vectorchord=${config.vectorchord} rerank=${config.rerank}`,
  );
  console.log(`${"#".repeat(80)}`);

  console.log(`  Creating database "${dbName}"...`);
  await createDatabase(adminUrl, dbName);
  createdDbs.add(dbName);

  const dbUrl = withDatabase(adminUrl, dbName);
  const { txProvider, migrationProvider, sql } = createAdapter(
    postgres(dbUrl, { max: SEARCH_CONCURRENCY * 3 + 4 }),
  );

  const cleanup = async () => {
    await sql.end({ timeout: 5 }).catch(() => {});
    await dropDatabase(adminUrl, dbName).catch(() => {});
    createdDbs.delete(dbName);
  };

  try {
    console.log(`  Migrating (vectorchord=${config.vectorchord}, bm25=${config.bm25}, cjk=false)...`);
    await ragMigrate(migrationProvider, {
      sqlDir: fileURLToPath(new URL("../../sql", import.meta.url)),
      vectorchord: config.vectorchord,
      bm25: config.bm25,
      cjk: false,
      embeddingDimensions: Number(process.env.EMBEDDING_DIM) || 384,
    });

    console.log("  Seeding Thai stop words...");
    await seedThaiStopWords(sql);

    const stopWords = new CachingStopWordsLoader({
      txProvider,
      normalizeWord: normalizeForLanguage,
    });

    // The headline axis: build this arm's segmenter and inject the SAME instance into the
    // db (keyword-leg routing), the indexer (content_normalized), and the pipeline (lexical
    // query). NOT into the Chunker — chunk text is arm-independent (corpus is pre-built).
    const segmenter = createSegmenter(config.segmenter);

    const db = new PostgresRagDatabase(txProvider, {
      ...(config.bm25 ? { fts: new Bm25Fts() } : {}),
      ...(segmenter ? { segmenter } : {}),
    });

    const indexer = new RagIndexer({
      tenantId: TENANT_ID,
      db,
      embedder,
      normalizer: new LanguageNormalizer(),
      ...(segmenter ? { segmenter } : {}),
      logger,
    });

    console.log(`  Indexing ${docOrder.length} docs (${corpus.length} chunks)...`);
    let indexed = 0;
    for (const doc of docOrder) {
      const chunks = doc.chunks.map((c, i) => ({
        content: c.content,
        index: i,
        metadata: { language: "th", domain: c.domain, provider: c.provider, source: c.source },
      }));
      indexed += await indexer.index(doc.source, docIdToUuid(doc.doc_id), chunks, "th");
    }
    console.log(`  Indexed ${indexed} chunks across ${docOrder.length} docs.`);

    const pipeline = new RagPipeline({
      tenantId: TENANT_ID,
      db,
      embedder,
      normalizer: new LanguageNormalizer(),
      stopWords,
      ...(segmenter ? { segmenter } : {}),
      logger,
      ...(config.rerank && reranker ? { reranker } : {}),
    });
    if (config.rerank && !reranker) {
      console.warn("  --rerank requested but no RERANKER_BASE_URL; running without reranker.");
    }

    const envVms = process.env.VECTOR_MIN_SCORE;
    const vectorMinScore =
      envVms !== undefined && envVms !== "" && Number.isFinite(Number(envVms))
        ? Number(envVms)
        : undefined;
    if (vectorMinScore !== undefined) {
      console.log(`  Using vectorMinScore=${vectorMinScore} (VECTOR_MIN_SCORE override).`);
    }

    console.log(
      `  Scoring ${queries.length} queries × ${REGISTERS.length} registers (concurrency=${SEARCH_CONCURRENCY})...`,
    );
    const searchTasks = queries.flatMap((query) =>
      REGISTERS.flatMap((register) => {
        const variant = query.variants[register];
        return variant ? [{ query, register, variant }] : [];
      }),
    );
    const outcomes: QueryOutcome[] = await mapWithConcurrency(
      searchTasks,
      SEARCH_CONCURRENCY,
      async ({ query, register, variant }): Promise<QueryOutcome> => {
        const results = await pipeline.search(variant, {
          topK,
          language: "th",
          rerank: config.rerank,
          ...(vectorMinScore !== undefined ? { vectorMinScore } : {}),
        });
        return {
          rankedDocIds: results.map((r) =>
            r.sourceId ? (docIdByUuid.get(r.sourceId) ?? r.sourceId) : "",
          ),
          targetDoc: query.target_doc,
          register,
          domain: query.domain,
          provider: query.provider,
          loanword: isLoanwordHeavy(variant),
          source: "faq",
        };
      },
    );

    const overall = summarize(outcomes);
    const byRegister = sliceBy(outcomes, (o) => o.register);
    const byDomain = sliceBy(outcomes, (o) => o.domain);
    const byLoanword = sliceBy(outcomes, (o) => (o.loanword ? "loanword" : "native"));

    result.overall = overall;
    result.byRegister = mapToRecord(byRegister);
    result.byDomain = mapToRecord(byDomain);
    result.byLoanword = mapToRecord(byLoanword);

    printSummaryTable(`[${config.name}] overall`, [["all", overall]]);
    printSummaryTable(`[${config.name}] by register`, [...byRegister.entries()]);
    printSummaryTable(`[${config.name}] by domain`, [...byDomain.entries()]);
    printSummaryTable(`[${config.name}] by loanword`, [...byLoanword.entries()]);

    if (keepForJudge) {
      return { result, keep: { pipeline, sql, dbName, adminUrl, rerank: config.rerank } };
    }

    await cleanup();
    return { result };
  } catch (err) {
    await cleanup();
    result.status = "failed";
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`  CONFIG "${config.name}" FAILED: ${result.error}`);
    return { result };
  }
}
```

- [ ] **Step 9: Replace `seedArabicStopWords` with `seedThaiStopWords`.**

Replace the whole `async function seedArabicStopWords(sql: postgres.Sql): Promise<void> { ... }` (keep the parameterized-insert mechanics; swap the word list, language `'th'`, and log text):

```ts
// ── Thai stop words (common function words; PyThaiNLP-style minimal set) ──────
async function seedThaiStopWords(sql: postgres.Sql): Promise<void> {
  const words = [
    "ที่",
    "และ",
    "การ",
    "ของ",
    "ใน",
    "เป็น",
    "มี",
    "ได้",
    "ว่า",
    "จะ",
    "ไม่",
    "ให้",
    "กับ",
    "ก็",
    "นี้",
    "หรือ",
    "แต่",
    "โดย",
    "ความ",
    "จาก",
    "ด้วย",
    "อยู่",
    "ต้อง",
    "แล้ว",
  ];
  const placeholders = words
    .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
    .join(", ");
  const params = words.flatMap((w) => [TENANT_ID, "th", w]);
  await sql.unsafe(
    `INSERT INTO rag_stop_words (tenant_id, language, word) VALUES ${placeholders}`,
    params,
  );
  console.log(`    Seeded ${words.length} Thai stop words.`);
}
```

- [ ] **Step 10: Update `main()`** — config selection, drop `cjk`, register snippet language, judge variant.

(a) Replace the `const configs: BenchConfig[] = args.matrix ? ... : [...]` selection with:

```ts
  const configs: BenchConfig[] = args.matrix
    ? MATRIX
    : args.segMatrix
      ? SEG_MATRIX
      : [
          {
            name: "custom",
            bm25: args.bm25,
            vectorchord: args.vectorchord,
            rerank: args.rerank,
            segmenter: args.segmenter,
          },
        ];
```

(b) In the snippet-validation block, change `normalizeForLanguage(s, "ar")` to `normalizeForLanguage(s, "th")`.

(c) In the `runConfig(...)` call inside the loop, **remove the `args.cjk,` argument** (the new signature has no `cjk` param). The call becomes:

```ts
      const run = await runConfig(
        config,
        args.topK,
        adminUrl,
        corpus,
        docOrder,
        selectedQueries,
        docIdByUuid,
        embedder,
        reranker,
        keepForJudge,
        createdDbs,
      );
```

(d) In the judge pass, change the variant from `q.variants.msa` to `q.variants.written` **and** the search `language` from `"ar"` to `"th"`. Replace:

```ts
        for (const q of judgeQueries) {
          const variant = q.variants.msa;
          if (!variant) continue;
          const searchResults = await judgeKeep.pipeline.search(variant, {
            topK: args.topK,
            language: "ar",
            rerank: judgeKeep.rerank,
          });
```

with:

```ts
        for (const q of judgeQueries) {
          const variant = q.variants.written;
          if (!variant) continue;
          const searchResults = await judgeKeep.pipeline.search(variant, {
            topK: args.topK,
            language: "th",
            rerank: judgeKeep.rerank,
          });
```

(e) The results-JSON `args` field already serializes the new `Args` shape (no `cjk`); leave the `JSON.stringify` block as-is.

- [ ] **Step 11: Lint + import-smoke (no DB run yet)**

Run: `bun run lint`
Run: `bun -e "import('./examples/benchmark-thai/run.ts').catch(e=>{console.error(String(e));process.exit(1)})" --help` — NOTE this will execute `main()`. Instead, only lint here; the live run is Task 14. Verify by careful read that: (1) no remaining `Dialect`/`cjk`/`seedArabicStopWords`/`byDialect` references (`grep -n "Dialect\|cjk\|Arabic\|byDialect\|\.msa" examples/benchmark-thai/run.ts` returns nothing), (2) `REGISTERS`, `SEG_MATRIX`, `createSegmenter`, `isLoanwordHeavy`, `seedThaiStopWords` are all used.

Run: `grep -nE "Dialect|cjk|Arabic|byDialect|\.msa|seedArabic" examples/benchmark-thai/run.ts`
Expected: no output.

- [ ] **Step 12: Commit**

```bash
git add examples/benchmark-thai/run.ts
git commit -m "feat(benchmark-thai): runner with segmenter sweep × config matrix"
```

---

## Phase 3 — Data acquisition (live; produces gitignored artifacts)

> These tasks use the live web (Playwright MCP) + a Python venv with pypdf. They cannot be unit-tested; verification is schema + count checks. **Degrade gracefully**: any provider that won't render is dropped and recorded in `scrape-notes.md`.

### Task 9: Scrape FAQ pairs → `datasets/faqs-th/*.jsonl`

**Files:**
- Create (gitignored): `datasets/faqs-th/<provider>.jsonl` (one JSONL per provider that yields)
- Create (committed): `examples/benchmark-thai/scrape-notes.md`
- Create: `examples/benchmark-thai/scrape/README.md` (the scrape procedure, committed)

**Interfaces:**
- Produces: `FaqRecord` JSONL — `{ doc_id: "faq:<provider>:<ordinal>", domain, provider, question, answer }`, ordinal contiguous per provider starting at 0.

- [ ] **Step 1: Bring up Playwright MCP** and, per provider in {AIS, True, dtac, SCB, KBank, Bangkok Bank, AIA, Muang Thai, FWD}, navigate to the help-center / FAQ pages, render, and extract question→answer pairs. Prefer pages that expose substantive procedural answers (drop terse one-clause answers, per the Arabic `scrape-notes.md` policy). Record each provider's source URL(s), date, method, and pair count.

- [ ] **Step 2: Write each provider's pairs to `datasets/faqs-th/<provider>.jsonl`**, one `FaqRecord` per line, `ensure_ascii`-off (raw Thai). Assign `domain` from the provider's domain (telecom/banking/insurance) and `doc_id = faq:<provider>:<ordinal>` with `ordinal` 0-based and contiguous within the provider's file.

- [ ] **Step 3: Validate the snapshots** with a one-off check (schema + non-empty + contiguous ordinals + counts by domain):

```bash
bun -e '
import { readdirSync, readFileSync, existsSync } from "node:fs";
const dir = "datasets/faqs-th";
if (!existsSync(dir)) { console.error("no datasets/faqs-th"); process.exit(1); }
let total = 0; const byDomain = {};
for (const f of readdirSync(dir).filter(f=>f.endsWith(".jsonl"))) {
  const lines = readFileSync(`${dir}/${f}`,"utf8").trim().split("\n").filter(Boolean);
  lines.forEach((l,i)=>{
    const r = JSON.parse(l);
    if (!r.doc_id || !r.question || !r.answer || !r.domain || !r.provider) throw new Error(`${f} line ${i}: missing field`);
    if (r.doc_id !== `faq:${r.provider}:${i}`) throw new Error(`${f} line ${i}: doc_id/ordinal mismatch ${r.doc_id}`);
    byDomain[r.domain] = (byDomain[r.domain]||0)+1;
  });
  total += lines.length;
  console.log(`${f}: ${lines.length} pairs`);
}
console.log(`TOTAL ${total} pairs`, byDomain);
'
```
Expected: all three domains (`telecom`, `banking`, `insurance`) present; total in the low hundreds (target ~250–350, but accept whatever yields). Fix any schema/ordinal error before continuing.

- [ ] **Step 4: Write `scrape-notes.md`** (model on `examples/benchmark/scrape-notes.md`): per-provider table (Source URL, method=Playwright/render, date, domain, pair count, output file), a "Sources Attempted but Failed" table (providers that wouldn't render / 403), and a Summary table with the final per-domain totals. State explicitly that snapshots are gitignored and not redistributed.

- [ ] **Step 5: Write `examples/benchmark-thai/scrape/README.md`** documenting the repeatable procedure (which URLs, how rendered via Playwright, the `FaqRecord` schema, the validation command from Step 3) so the scrape is reproducible.

- [ ] **Step 6: Commit the committed artifacts only** (snapshots are gitignored — added in Task 13; verify they are NOT staged)

```bash
git add examples/benchmark-thai/scrape-notes.md examples/benchmark-thai/scrape/README.md
git status --short   # confirm no datasets/faqs-th/ files staged
git commit -m "docs(benchmark-thai): FAQ scrape provenance + procedure"
```

---

### Task 10: Download policy PDFs + extract → `extracted.jsonl`

**Files:**
- Create (gitignored): `datasets/PDFs-th/<provider>_<freeform>.pdf`
- Create (gitignored): `datasets/benchmark-cache-th/extracted.jsonl`

- [ ] **Step 1: Collect ~10–15 policy / T&C / product PDFs** from the same providers (e.g. roaming terms, account T&C, insurance policy summaries). Save each to `datasets/PDFs-th/` using the `<provider>_<freeform>.pdf` convention so `extract_pdfs.py` classifies the domain (e.g. `ais_roaming_terms.pdf`, `scb_account_tc.pdf`, `aia_policy_summary.pdf`). Record provenance in `scrape-notes.md` (append a "Policy PDFs" section).

- [ ] **Step 2: Ensure pypdf is available, then extract**

```bash
python -m pip install --quiet pypdf
python examples/benchmark-thai/extract_pdfs.py
```
Expected: per-file `… -> N pages (provider=…, domain=…)` lines and `Wrote datasets/benchmark-cache-th/extracted.jsonl`.

- [ ] **Step 3: Sanity-check extracted Thai text is present**

```bash
bun -e '
import { readFileSync } from "node:fs";
const recs = readFileSync("datasets/benchmark-cache-th/extracted.jsonl","utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
let thai = 0;
for (const r of recs) { const t = r.pages.join(""); if (/[ก-๎]/.test(t)) thai++; }
console.log(`${recs.length} PDFs extracted, ${thai} contain Thai script`);
if (thai === 0) { console.error("WARNING: no Thai text extracted — check the PDFs are text (not scanned images)"); process.exit(1); }
'
```
Expected: most PDFs contain Thai script. If a PDF is a scanned image (no text), drop it and note it (no OCR in scope).

- [ ] **Step 4: Append the "Policy PDFs" provenance** to `scrape-notes.md` (sources, dates, count) and commit that doc change (PDFs + extracted.jsonl are gitignored).

```bash
git add examples/benchmark-thai/scrape-notes.md
git commit -m "docs(benchmark-thai): policy PDF distractor provenance"
```

---

### Task 11: Build the corpus from scraped data

**Files:**
- Create (gitignored): `datasets/benchmark-cache-th/corpus.jsonl`

- [ ] **Step 1: Build the answer-only corpus**

```bash
bun run examples/benchmark-thai/buildCorpus.ts
```
Expected: `corpus (answer-only) -> datasets/benchmark-cache-th/corpus.jsonl: <N> chunks (faq=<F>, pdf=<P>)` with `F > 0` and `P > 0`.

- [ ] **Step 2: Verify the corpus shape**

```bash
bun -e '
import { readFileSync } from "node:fs";
const cs = readFileSync("datasets/benchmark-cache-th/corpus.jsonl","utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
const faqDocs = new Set(cs.filter(c=>c.source==="faq").map(c=>c.doc_id));
const pdfDocs = new Set(cs.filter(c=>c.source==="pdf").map(c=>c.doc_id));
const domains = [...new Set(cs.map(c=>c.domain))].sort();
console.log(`chunks=${cs.length} faqDocs=${faqDocs.size} pdfDocs=${pdfDocs.size} domains=${domains}`);
if (faqDocs.size === 0 || pdfDocs.size === 0) process.exit(1);
'
```
Expected: non-zero faq + pdf docs; domains = `["banking","insurance","telecom"]` (or whatever subset yielded).

> No commit — the corpus cache is gitignored.

---

## Phase 4 — Queries, gitignore, end-to-end run, docs

### Task 12: Author `queries.json` (3 register variants per FAQ)

**Files:**
- Create (committed): `examples/benchmark-thai/queries.json`

**Interfaces:**
- Produces: a `QueriesFile` — `{ version: 1, queries: BenchmarkQuery[] }`. Each `target_doc` MUST be a `faq:*` doc_id present in `datasets/benchmark-cache-th/corpus.jsonl`. `target_snippet` MUST be a substring of that doc's indexed chunk text (snippet validation in `run.ts` warns otherwise).

- [ ] **Step 1: List candidate target docs** (the FAQ doc_ids + their answer text) to author against:

```bash
bun -e '
import { readFileSync } from "node:fs";
const cs = readFileSync("datasets/benchmark-cache-th/corpus.jsonl","utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
const byDoc = new Map();
for (const c of cs) if (c.source==="faq") { const e = byDoc.get(c.doc_id) ?? {domain:c.domain, provider:c.provider, text:""}; e.text += c.content+" "; byDoc.set(c.doc_id, e); }
for (const [id,e] of byDoc) console.log(id, "|", e.domain, e.provider, "|", e.text.slice(0,120).replace(/\n/g," "));
'
```

- [ ] **Step 2: Author the query set.** For a spread of FAQ docs across all three domains and all three providers per domain, write one `BenchmarkQuery` each with three register variants of the SAME information need, sharing the doc's `target_doc`. Target ~60–120 queries (a useful subset of the FAQ docs; not every doc needs a query). Follow these rules:
  - `written`: formal written Thai (full question form).
  - `spoken`: colloquial spoken Thai (contractions, ยังไง, etc.).
  - `codeswitch`: mixed-script — Latin-script brand/loanword tokens inline.
  - The `written`/`spoken` variants should carry **Thai-script transliterations** where natural (โรมมิ่ง, แพ็กเกจ, อินเทอร์เน็ต, ซิม, เครดิต) — these are the OOV terms the segmenter axis stresses.
  - `target_snippet`: a short verbatim slice of the target doc's answer (used for the snippet-presence warning).

Example record (shape to follow exactly):

```json
{
  "version": 1,
  "queries": [
    {
      "id": "q0001",
      "domain": "telecom",
      "provider": "ais",
      "target_doc": "faq:ais:12",
      "target_snippet": "เปิดใช้บริการข้ามแดนอัตโนมัติ",
      "variants": {
        "written": "จะเปิดใช้บริการโรมมิ่งระหว่างประเทศได้อย่างไร",
        "spoken": "เปิดโรมมิ่งต่างประเทศยังไง",
        "codeswitch": "เปิด international roaming ยังไง"
      }
    }
  ]
}
```

- [ ] **Step 3: Validate queries against the corpus** (resolution + snippet presence) using the real library normalizer:

```bash
bun -e '
import { readFileSync } from "node:fs";
import { normalizeForLanguage } from "./src/index.js";
import { loadQueries, resolveQueries, snippetPresent } from "./examples/benchmark-thai/qrels.ts";
const cs = readFileSync("datasets/benchmark-cache-th/corpus.jsonl","utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
const docText = new Map();
for (const c of cs) docText.set(c.doc_id, (docText.get(c.doc_id)??"") + " " + c.content);
const ids = new Set(cs.map(c=>c.doc_id));
const { queries } = loadQueries("examples/benchmark-thai/queries.json");
const { resolved, unresolved } = resolveQueries(queries, ids);
console.log(`queries=${queries.length} resolved=${resolved.length} unresolved=${unresolved.length}`);
if (unresolved.length) console.log("UNRESOLVED:", unresolved.map(q=>q.id+"→"+q.target_doc));
const missing = resolved.filter(q => !snippetPresent(q.target_snippet, docText.get(q.target_doc)??"", s=>normalizeForLanguage(s,"th")));
if (missing.length) console.log("MISSING SNIPPET:", missing.map(q=>q.id));
if (unresolved.length || missing.length) process.exit(1);
console.log("queries.json OK");
'
```
Expected: `unresolved=0`, no missing snippets, `queries.json OK`. Fix any unresolved `target_doc` (must exist in corpus) or missing snippet (must be a substring of the target doc) before committing.

- [ ] **Step 4: Commit**

```bash
git add examples/benchmark-thai/queries.json
git commit -m "feat(benchmark-thai): authored query set (3 register variants)"
```

---

### Task 13: Gitignore + README

**Files:**
- Modify: `.gitignore`
- Create (committed): `examples/benchmark-thai/README.md`

- [ ] **Step 1: Append Thai-benchmark ignores to `.gitignore`**

Add these lines (mirroring the existing Arabic `datasets/faqs/*.jsonl`, `datasets/benchmark-cache/`, `examples/benchmark/results/` entries):

```gitignore
# Thai benchmark (scraped/derived, not redistributed)
datasets/faqs-th/
datasets/PDFs-th/
datasets/benchmark-cache-th/
examples/benchmark-thai/results/
```

- [ ] **Step 2: Verify nothing sensitive is tracked**

```bash
git status --ignored --short datasets/faqs-th datasets/PDFs-th datasets/benchmark-cache-th examples/benchmark-thai/results 2>/dev/null
git ls-files datasets/faqs-th datasets/PDFs-th datasets/benchmark-cache-th
```
Expected: the second command prints nothing (no scraped data tracked).

- [ ] **Step 3: Write `examples/benchmark-thai/README.md`** (model on `examples/benchmark/README.md`) covering:
  - **What it measures:** Thai segmentation quality (none/intl/attacut) over telecom/banking/insurance FAQ + policy-PDF distractors; 3 register variants; slices by register/domain/loanword/segmenter.
  - **Prerequisites:** Postgres (pgvector + pg_trgm), the infinity compose (`examples/benchmark/docker-compose.infinity.yml`, serving BGE-M3 + bge-reranker-v2-m3), the attacut sidecar (`examples/thai-segmenter/`, host port 8100), Python 3 + pypdf.
  - **`.env` keys:** `DATABASE_URL` or `POSTGRES_*`; `EMBEDDING_BASE_URL=http://localhost:7997`, `EMBEDDING_MODEL=BAAI/bge-m3`, `EMBEDDING_API_KEY`, **`EMBEDDING_DIM=1024`**, **`VECTOR_MIN_SCORE=0.4`**, `EMBEDDING_BATCH_SIZE=8`; `RERANKER_BASE_URL=http://localhost:7997`, `RERANKER_MODEL=BAAI/bge-reranker-v2-m3`; **`THAI_SEGMENTER_URL=http://localhost:8100`**; optional `JUDGE_*`.
  - **Prep (one-time):** scrape FAQs (see `scrape-notes.md` + `scrape/README.md`); collect policy PDFs → `python examples/benchmark-thai/extract_pdfs.py`; `bun run examples/benchmark-thai/buildCorpus.ts`.
  - **Running:** the `--seg-matrix` headline, `--matrix` extension, single-config flags (`--segmenter none|intl|attacut`, `--bm25`, `--vectorchord`, `--rerank`), `--topk`, `--limit-queries`, `--judge`.
  - **Scoring & output:** metrics, slices (register/domain/loanword), the cross-segmenter comparison table, `results/<ts>.json`.
  - **Corpus disclosure** + the honesty note that scraped content is gitignored and scrape yield is reported per-provider.

- [ ] **Step 4: Commit**

```bash
git add .gitignore examples/benchmark-thai/README.md
git commit -m "docs(benchmark-thai): gitignore scraped artifacts + README"
```

---

### Task 14: End-to-end smoke + headline run

**Files:** none (produces gitignored `examples/benchmark-thai/results/<ts>.json`)

- [ ] **Step 1: Bring up services**

```bash
cd examples && podman compose up -d db && cd ..
podman compose -f examples/benchmark/docker-compose.infinity.yml up -d
cd examples && podman compose up -d thai-segmenter && cd ..   # attacut sidecar on :8100
```
Wait for infinity to load models (`podman compose -f examples/benchmark/docker-compose.infinity.yml logs -f infinity`) and the segmenter `/health` to return ok (`curl -f http://localhost:8100/health`).

- [ ] **Step 2: Smoke run (tiny)** — confirm the whole path works end-to-end:

```bash
bun run examples/benchmark-thai/run.ts --segmenter attacut --limit-queries 6 --topk 10
```
Expected: corpus disclosure prints; "Seeding Thai stop words"; indexing completes; per-config tables (overall + by register + by domain + by loanword) print; `Wrote results: …`. No crash. If the segmenter sidecar is down, you'll get a fail-fast error — bring it up and retry.

- [ ] **Step 3: Headline run**

```bash
bun run examples/benchmark-thai/run.ts --seg-matrix --topk 10
```
Expected: 6 configs (`baseline/none`, `+rerank/none`, `baseline/intl`, `+rerank/intl`, `baseline/attacut`, `+rerank/attacut`) succeed; the cross-config comparison shows the segmenter ordering. **Sanity-check the thesis:** on `baseline/*`, lexical-dependent recall should order `attacut ≥ intl > none`, and the gap should be larger on the `loanword` slice than the `native` slice. The dense control: `+rerank/*` differences should be smaller than `baseline/*` differences (the reranker is segmenter-blind).

- [ ] **Step 4: Record findings honestly.** In the final response (and optionally a short `BENCHMARKING_LOG.md` like the Arabic one — optional, commit if created), report: which providers were scraped vs dropped, the corpus size, the measured segmenter ordering + loanword-slice deltas, and explicitly what was run vs. what depends on the user's infra. Do NOT claim an ordering that the run didn't show — if `none` ties `attacut` (e.g. dense leg dominates), report that and note the lexical legs' limited contribution.

- [ ] **Step 5: Final full-suite gate**

```bash
bun test examples/benchmark-thai
bun run lint
```
Expected: all `examples/benchmark-thai/*.test.ts` pass; lint clean. (Do not run `bun run typecheck` against `examples/` — it's excluded; that's expected.)

> No commit for results (gitignored). If a `BENCHMARKING_LOG.md` was written, commit it: `git add examples/benchmark-thai/BENCHMARKING_LOG.md && git commit -m "docs(benchmark-thai): benchmarking log + findings"`.

---

## Self-Review

**1. Spec coverage:**
- Headline segmenter A/B/C → Tasks 6 (factory), 8 (`SEG_MATRIX`, injection), 14 (run). ✅
- New dir mirroring Arabic, no shared module → all tasks create under `examples/benchmark-thai/`. ✅
- Scrape FAQs (telecom/banking/insurance, 3×3, gitignored) → Task 9. ✅
- Policy PDF distractors + Thai cleaning → Tasks 3 (`cleanThai`), 7 (`extract_pdfs`), 10. ✅
- Corpus build with **plain `chunk()`** (control) → Task 7 (`buildCorpus.ts` comment + code), 11. ✅
- 3 register variants `queries.json` → Tasks 1 (`types`), 12. ✅
- Metrics + slices (register/domain/segmenter/**loanword cross-cut**) → Tasks 1 (`metrics`), 2 (`loanword`), 8 (slices + comparison). ✅
- Runner: `--seg-matrix` (headline) + `--matrix` (attacut fixed) + single-config, **no `--cjk`** → Task 8. ✅
- Infra reuse: BGE-M3 1024d, `VECTOR_MIN_SCORE≈0.4`, bge-reranker, attacut sidecar, FTS `'simple'` (no migration) → Tasks 6, 13 (README env), 14 (compose). ✅
- Thai stop words → Task 8 (`seedThaiStopWords`). ✅
- Verification = lint + read + smoke; honesty about yield → Tasks 8, 9, 14. ✅
- Gitignore scraped/derived; commit only queries.json + scrape-notes.md + code → Tasks 9, 13. ✅
- Non-goals (no `src/`/`tests/`/Arabic/playground/sidecar-internal changes; no transformer arm; no dialect axis) → respected throughout; Global Constraints restate them. ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N"/"write tests for the above". Task 9/10/12 are inherently live data steps — they specify concrete schema, validation commands, and acceptance checks rather than code (correct for data acquisition). ✅

**3. Type consistency:**
- `SegmenterKind` defined in Task 6, consumed in Task 8 import + `BenchConfig`. ✅
- `Register` defined in Task 1 (`types.ts`), used in `metrics.ts` (Task 1), `run.ts` `REGISTERS`/search loop (Task 8). ✅
- `QueryOutcome` shape (`register`, `loanword`) defined Task 1, constructed in `run.ts` Task 8 (`register`, `loanword: isLoanwordHeavy(variant)`). ✅
- `createSegmenter(kind)` (Task 6) called as `createSegmenter(config.segmenter)` (Task 8). ✅
- `isLoanwordHeavy` (Task 2) imported + used (Task 8). ✅
- `cleanThaiDoc` (Task 3) imported in `buildCorpus.ts` (Task 7). ✅
- `loadOrBuildCorpus` (Task 7) imported in `run.ts` (Task 8, retained from Arabic base). ✅
- `BenchmarkQuery.variants: Record<Register,…>` (Task 1) drives `q.variants[register]` and `q.variants.written` (Task 8). ✅
