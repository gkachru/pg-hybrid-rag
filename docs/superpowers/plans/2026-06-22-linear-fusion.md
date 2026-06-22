# Linear (Score-Normalized) Fusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in linear (score-normalized, weighted-sum) fusion strategy alongside RRF, selectable per query, and wire both into the Arabic benchmark.

**Architecture:** Fusion is a pure transform over already-fetched leg results, so it follows the codebase's exported-function pattern (`applyRRF`, `removeStopWords`), not a construction-injected interface. A new `applyLinearFusion` lives beside `applyRRF`; `RagPipeline.search` picks between them on a new per-query `fusion` option (default `"rrf"`). The legs' SQL already computes a `score`; we plumb it through `RankedCandidate` (currently dropped) so linear fusion can normalize and weight it. RRF stays behaviorally unchanged.

**Tech Stack:** TypeScript (strict, ES2022), Bun (`bun:test`, tsup build), Biome lint. Zero runtime dependencies.

## Global Constraints

- **Runtime/build:** Bun; tests use `bun:test`; build via tsup (targets `src/` only). Commands: `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`.
- **Strict TypeScript, no `any`.**
- **Linter:** Biome (`bun run lint`); auto-fix `bun run lint:fix`.
- **Zero runtime npm dependencies.**
- **All SQL parameterized** — never interpolate user input (no SQL changes in this plan anyway).
- **RRF path must stay behaviorally unchanged.** `applyRRF`'s output and signature are frozen; its only edit is importing extracted leaf helpers. The existing `tests/rrf.test.ts` is the regression guard and must pass untouched.
- **Linear fusion is opt-in.** `fusion` defaults to `"rrf"`; `fusionNormalizer` defaults to `"minmax"`. Default behavior is identical to today.
- **`score` is optional** on `RankedCandidate` (keeps `applyRRF`'s public contract non-breaking). `applyLinearFusion` treats an absent/non-finite score as `0`.
- **Branch:** work happens on `feat/linear-fusion` (already created; spec already committed there).

---

### Task 1: Plumb leg scores through `RankedCandidate`

**Files:**
- Modify: `src/types.ts` (the `RankedCandidate` interface)
- Modify: `src/adapters/sqlHelpers.ts` (`toRankedCandidate`)
- Test: `tests/sqlHelpers.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RankedCandidate.score?: number`. `toRankedCandidate(row)` now includes `score: Number(row.score)` **only when `row.score != null`** (absent → key omitted, so existing `.toEqual` fixtures stay valid).

- [ ] **Step 1: Write the failing test**

Add to the `describe("toRankedCandidate", …)` block in `tests/sqlHelpers.test.ts`:

```typescript
  it("maps a numeric score when the row has one", () => {
    const c = toRankedCandidate({
      id: "chunk-3",
      content: "c",
      source_type: "faq",
      source_id: "1",
      metadata: "{}",
      score: "0.42", // pg float may arrive as a string
    });
    expect(c.score).toBe(0.42);
  });

  it("omits score when the row has none", () => {
    const c = toRankedCandidate({
      id: "chunk-4",
      content: "c",
      source_type: "faq",
      source_id: "1",
      metadata: "{}",
    });
    expect("score" in c).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sqlHelpers.test.ts`
Expected: FAIL — `maps a numeric score` expects `0.42` but gets `undefined`; `score in c` is `false`/`true` mismatch.

- [ ] **Step 3: Add `score` to `RankedCandidate`**

In `src/types.ts`, inside `interface RankedCandidate`, after the `metadata: string;` line:

```typescript
  /**
   * Per-leg relevance score from the producing SQL (vector cosine, trgm word_similarity,
   * bigm coverage, ts_rank_cd, or bm25). Optional: RRF ignores it (rank-only), linear fusion
   * consumes it. Absent when a candidate is constructed without a score column.
   */
  score?: number;
```

- [ ] **Step 4: Map the score in `toRankedCandidate`**

In `src/adapters/sqlHelpers.ts`, replace the `toRankedCandidate` return object:

```typescript
export function toRankedCandidate(row: Record<string, unknown>): RankedCandidate {
  return {
    id: row.id as string,
    content: row.content as string,
    sourceType: row.source_type as string,
    sourceId: row.source_id as string | null,
    metadata: (row.metadata as string) || "{}",
    // Carry the leg's score only when present, so candidates built without a score column
    // (and existing exact-match test fixtures) keep the key absent rather than NaN.
    ...(row.score != null ? { score: Number(row.score) } : {}),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/sqlHelpers.test.ts`
Expected: PASS (all `buildFilters` + `toRankedCandidate` tests, including the two new ones).

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/adapters/sqlHelpers.ts tests/sqlHelpers.test.ts
git commit -m "feat(fusion): plumb per-leg score through RankedCandidate"
```

---

### Task 2: Extract shared fusion leaf helpers; refactor `rrf.ts` (no behavior change)

**Files:**
- Create: `src/fusionShared.ts`
- Modify: `src/rrf.ts`
- Test: `tests/fusionShared.test.ts` (new), `tests/rrf.test.ts` (existing regression guard — unchanged)

**Interfaces:**
- Consumes: `RankedCandidate` (with optional `score`) and `RagResult` from `src/types.js`.
- Produces, from `src/fusionShared.js`:
  - `parseMetadata(raw: string | null | undefined): Record<string, string>`
  - `toRagResult(candidate: RankedCandidate, score: number): RagResult`

- [ ] **Step 1: Write the failing test**

Create `tests/fusionShared.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { parseMetadata, toRagResult } from "../src/fusionShared.js";

describe("parseMetadata", () => {
  it("parses a JSON object", () => {
    expect(parseMetadata('{"a":"b"}')).toEqual({ a: "b" });
  });
  it("returns {} for null/empty", () => {
    expect(parseMetadata(null)).toEqual({});
    expect(parseMetadata("")).toEqual({});
  });
  it("returns {} for malformed JSON", () => {
    expect(parseMetadata("{not json")).toEqual({});
  });
  it("returns {} for valid-but-non-object JSON", () => {
    for (const raw of ["42", "[1,2]", "null", '"s"', "true"]) {
      expect(parseMetadata(raw)).toEqual({});
    }
  });
});

describe("toRagResult", () => {
  it("maps a candidate + score into a RagResult with parsed metadata", () => {
    const r = toRagResult(
      { id: "x", content: "C", sourceType: "faq", sourceId: "1", metadata: '{"k":"v"}' },
      0.75,
    );
    expect(r).toEqual({
      content: "C",
      sourceType: "faq",
      sourceId: "1",
      score: 0.75,
      metadata: { k: "v" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/fusionShared.test.ts`
Expected: FAIL — cannot resolve `../src/fusionShared.js`.

- [ ] **Step 3: Create `src/fusionShared.ts`**

```typescript
import type { RagResult, RankedCandidate } from "./types.js";

/**
 * Parse a candidate's metadata JSON, falling back to {} on malformed or non-object input.
 * The fusion functions are public and may receive arbitrary rows, so a bad value must not throw.
 */
export function parseMetadata(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || "{}");
    // Reject valid-but-non-object JSON (numbers, arrays, null) so it isn't returned
    // typed as Record<string, string>. Library rows are always objects, but callers are public.
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/** Map a fused candidate + its computed fusion score into the public RagResult shape. */
export function toRagResult(candidate: RankedCandidate, score: number): RagResult {
  return {
    content: candidate.content,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    score,
    metadata: parseMetadata(candidate.metadata),
  };
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `bun test tests/fusionShared.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor `rrf.ts` to use the shared helpers**

Replace the entire contents of `src/rrf.ts` with:

```typescript
import { toRagResult } from "./fusionShared.js";
import type { RagResult, RankedCandidate } from "./types.js";

/**
 * Reciprocal Rank Fusion: merge ranked lists into a single score.
 * rrf_score(doc) = weight_i / (k + rank_i) for each leg where doc appears.
 * When no weights are provided, all legs are weighted equally at 1.
 */
export function applyRRF(
  legs: Array<{ items: RankedCandidate[] }>,
  rrfK: number,
  topK: number,
  weights?: number[],
): RagResult[] {
  const scoreMap = new Map<string, { score: number; candidate: RankedCandidate }>();

  for (let legIdx = 0; legIdx < legs.length; legIdx++) {
    const leg = legs[legIdx];
    // Default to weight 1 for any leg with no corresponding entry — guards both a
    // wholly-absent array and one shorter than `legs` (weights[legIdx] === undefined → NaN).
    const w = weights?.[legIdx] ?? 1;
    for (let rank = 0; rank < leg.items.length; rank++) {
      const item = leg.items[rank];
      // Deduplicate by stable chunk id (same chunk may appear in multiple legs).
      // Keying on id — not content — keeps distinct chunks with identical text separate.
      const key = item.id;
      const rrfScore = w / (rrfK + rank + 1);

      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, candidate: item });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ score, candidate }) => toRagResult(candidate, score));
}
```

- [ ] **Step 6: Run the RRF regression guard + new test**

Run: `bun test tests/rrf.test.ts tests/fusionShared.test.ts`
Expected: PASS — all existing `applyRRF` tests green (behavior unchanged), plus `fusionShared`.

- [ ] **Step 7: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/fusionShared.ts src/rrf.ts tests/fusionShared.test.ts
git commit -m "refactor(fusion): extract parseMetadata + toRagResult into fusionShared"
```

---

### Task 3: `applyLinearFusion` + normalizers + fusion type aliases + barrel export

**Files:**
- Modify: `src/types.ts` (add `FusionMethod` + `FusionNormalizer` type aliases)
- Create: `src/linearFusion.ts`
- Modify: `src/index.ts` (export `applyLinearFusion` + the type aliases)
- Test: `tests/linearFusion.test.ts` (new)

**Interfaces:**
- Consumes: `toRagResult` from `src/fusionShared.js` (Task 2); `RankedCandidate.score` (Task 1).
- Produces:
  - In `src/types.js`: `type FusionMethod = "rrf" | "linear"`, `type FusionNormalizer = "minmax" | "l2"`.
  - In `src/linearFusion.js`: `applyLinearFusion(legs: Array<{ items: RankedCandidate[] }>, topK: number, weights?: number[], normalizer?: FusionNormalizer): RagResult[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/linearFusion.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { applyLinearFusion } from "../src/linearFusion.js";

const c = (id: string, score?: number) => ({
  id,
  content: id,
  sourceType: "faq",
  sourceId: id,
  metadata: "{}",
  ...(score === undefined ? {} : { score }),
});

describe("applyLinearFusion", () => {
  it("minmax: orders by normalized score within a single leg", () => {
    // raw [0.95, 0.80, 0.55] -> minmax [1.0, 0.625, 0.0]
    const out = applyLinearFusion([{ items: [c("hi", 0.95), c("mid", 0.8), c("lo", 0.55)] }], 10);
    expect(out.map((r) => r.content)).toEqual(["hi", "mid", "lo"]);
    expect(out[0].score).toBeCloseTo(1.0, 6);
    expect(out[1].score).toBeCloseTo(0.625, 6);
    expect(out[2].score).toBeCloseTo(0.0, 6);
  });

  it("l2: normalizes by vector norm, preserving relative magnitude", () => {
    // raw [0.95, 0.80, 0.55], norm = sqrt(0.95^2+0.8^2+0.55^2) ~= 1.3454
    const out = applyLinearFusion(
      [{ items: [c("a", 0.95), c("b", 0.8), c("c", 0.55)] }],
      10,
      undefined,
      "l2",
    );
    const norm = Math.sqrt(0.95 ** 2 + 0.8 ** 2 + 0.55 ** 2);
    expect(out[0].score).toBeCloseTo(0.95 / norm, 6);
    expect(out[2].score).toBeCloseTo(0.55 / norm, 6);
  });

  it("weighted sum across legs dedups by id", () => {
    // vector: A=1.0,B=0.0 (minmax of [0.9,0.5]); keyword: A=1.0 (single -> 1.0)
    // weights [1,2]: A = 1*1.0 + 2*1.0 = 3.0; B = 1*0.0 = 0.0
    const out = applyLinearFusion(
      [
        { items: [c("A", 0.9), c("B", 0.5)] },
        { items: [c("A", 0.3)] },
      ],
      10,
      [1, 2],
    );
    expect(out[0].content).toBe("A");
    expect(out[0].score).toBeCloseTo(3.0, 6);
    const b = out.find((r) => r.content === "B");
    expect(b?.score).toBeCloseTo(0.0, 6);
  });

  it("minmax: a single-candidate or all-equal leg normalizes to 1.0", () => {
    const single = applyLinearFusion([{ items: [c("only", 0.42)] }], 10);
    expect(single[0].score).toBeCloseTo(1.0, 6);
    const equal = applyLinearFusion([{ items: [c("x", 0.5), c("y", 0.5)] }], 10);
    expect(equal[0].score).toBeCloseTo(1.0, 6);
    expect(equal[1].score).toBeCloseTo(1.0, 6);
  });

  it("treats an absent or non-finite score as 0", () => {
    // both scores absent -> [0,0] -> minmax max==min -> both 1.0 (degenerate rule)
    const out = applyLinearFusion([{ items: [c("p"), c("q")] }], 10);
    expect(out.every((r) => Number.isFinite(r.score))).toBe(true);
  });

  it("skips an empty leg and respects topK", () => {
    const out = applyLinearFusion(
      [{ items: [c("A", 0.9), c("B", 0.5), c("C", 0.1)] }, { items: [] }],
      2,
    );
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.content)).toEqual(["A", "B"]);
  });

  it("parses metadata via the shared mapper", () => {
    const out = applyLinearFusion(
      [{ items: [{ id: "m", content: "M", sourceType: "faq", sourceId: "1", metadata: '{"k":"v"}', score: 1 }] }],
      10,
    );
    expect(out[0].metadata).toEqual({ k: "v" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/linearFusion.test.ts`
Expected: FAIL — cannot resolve `../src/linearFusion.js`.

- [ ] **Step 3: Add the fusion type aliases to `src/types.ts`**

At the top of `src/types.ts` (before `interface RagResult`), add:

```typescript
/** Fusion method for combining the search legs. */
export type FusionMethod = "rrf" | "linear";

/** Per-leg score normalization for linear fusion. */
export type FusionNormalizer = "minmax" | "l2";
```

- [ ] **Step 4: Create `src/linearFusion.ts`**

```typescript
import { toRagResult } from "./fusionShared.js";
import type { FusionNormalizer, RagResult, RankedCandidate } from "./types.js";

/**
 * Normalize one leg's candidate scores into a comparable range so a weighted sum across legs
 * is meaningful (leg scales differ wildly: cosine 0–1, ts_rank tiny, bm25 unbounded).
 * Absent/non-finite scores are treated as 0.
 *  - "minmax": (s - min) / (max - min) → [0,1]. When max == min (single candidate or all-equal)
 *    every candidate normalizes to 1.0 (the leg cannot distinguish them; it fully endorses each).
 *  - "l2": s / sqrt(Σ sᵢ²) → preserves relative magnitude; a lone positive score → 1.0.
 */
function normalizeLeg(items: RankedCandidate[], method: FusionNormalizer): number[] {
  const scores = items.map((it) =>
    typeof it.score === "number" && Number.isFinite(it.score) ? it.score : 0,
  );
  if (scores.length === 0) return [];

  if (method === "l2") {
    const norm = Math.sqrt(scores.reduce((acc, x) => acc + x * x, 0));
    return norm > 0 ? scores.map((x) => x / norm) : scores.map(() => 0);
  }

  // minmax
  let min = scores[0];
  let max = scores[0];
  for (const x of scores) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (max === min) return scores.map(() => 1);
  return scores.map((x) => (x - min) / (max - min));
}

/**
 * Linear fusion: normalize each leg's scores independently, then a weighted sum across legs,
 * deduplicated by chunk id. An alternative to applyRRF that uses the legs' actual relevance
 * magnitudes (not just rank). Leg/weight order matches applyRRF: [vector, keyword, fts].
 */
export function applyLinearFusion(
  legs: Array<{ items: RankedCandidate[] }>,
  topK: number,
  weights?: number[],
  normalizer: FusionNormalizer = "minmax",
): RagResult[] {
  const scoreMap = new Map<string, { score: number; candidate: RankedCandidate }>();

  for (let legIdx = 0; legIdx < legs.length; legIdx++) {
    const leg = legs[legIdx];
    const w = weights?.[legIdx] ?? 1;
    const normalized = normalizeLeg(leg.items, normalizer);
    for (let i = 0; i < leg.items.length; i++) {
      const item = leg.items[i];
      const contribution = w * normalized[i];
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.score += contribution;
      } else {
        scoreMap.set(item.id, { score: contribution, candidate: item });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ score, candidate }) => toRagResult(candidate, score));
}
```

- [ ] **Step 5: Export from the barrel**

In `src/index.ts`, change the utilities export line:

```typescript
export { applyRRF } from "./rrf.js";
export { applyLinearFusion } from "./linearFusion.js";
```

And add the type aliases to the `// Types` `export type { … } from "./types.js";` block (insert in alphabetical position):

```typescript
  FusionMethod,
  FusionNormalizer,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/linearFusion.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 7: Typecheck + lint + build**

Run: `bun run typecheck && bun run lint && bun run build`
Expected: no errors; dual ESM/CJS emitted.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/linearFusion.ts src/index.ts tests/linearFusion.test.ts
git commit -m "feat(fusion): add applyLinearFusion with minmax/l2 normalizers"
```

---

### Task 4: Wire the `fusion` option into `RagPipeline` + document it

**Files:**
- Modify: `src/types.ts` (`RagSearchOptions`)
- Modify: `src/RagPipeline.ts` (`DEFAULTS` + import + the fusion branch)
- Modify: `README.md` (search options table)
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `applyLinearFusion` (Task 3), `FusionMethod`/`FusionNormalizer` (Task 3).
- Produces: `RagSearchOptions.fusion?: FusionMethod` (default `"rrf"`), `RagSearchOptions.fusionNormalizer?: FusionNormalizer` (default `"minmax"`); `RagPipeline.search` dispatches to linear fusion when `fusion === "linear"`, using the same `fusedLimit` as RRF.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block in `tests/pipeline.test.ts` (after the existing reranking tests):

```typescript
  describe("fusion option", () => {
    it("defaults to RRF (rank-based) and ignores leg scores", async () => {
      // vector leg: 'lo' at position 0, 'hi' at position 1. RRF ranks by position → 'lo' first.
      vectorRows = [
        { content: "lo", sourceType: "faq", sourceId: "lo", metadata: "{}", score: 0.1 },
        { content: "hi", sourceType: "faq", sourceId: "hi", metadata: "{}", score: 0.9 },
      ] as typeof vectorRows;
      keywordRows = [];
      ftsRows = [];
      const out = await pipeline.search("q", { language: "en", topK: 2 });
      expect(out[0].content).toBe("lo");
    });

    it("fusion:'linear' orders by normalized score, not rank position", async () => {
      vectorRows = [
        { content: "lo", sourceType: "faq", sourceId: "lo", metadata: "{}", score: 0.1 },
        { content: "hi", sourceType: "faq", sourceId: "hi", metadata: "{}", score: 0.9 },
      ] as typeof vectorRows;
      keywordRows = [];
      ftsRows = [];
      const out = await pipeline.search("q", { language: "en", topK: 2, fusion: "linear" });
      expect(out[0].content).toBe("hi");
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline.test.ts`
Expected: FAIL — the `fusion:'linear'` case returns `"lo"` (RRF still in use; `fusion` not yet honored). (The default-RRF case passes already.)

- [ ] **Step 3: Add the options to `RagSearchOptions`**

In `src/types.ts`, inside `interface RagSearchOptions`, after the `rrfK?: number;` line, add:

```typescript
  /**
   * How the search legs are fused. "rrf" (default) = Reciprocal Rank Fusion (rank-only).
   * "linear" = per-leg score normalization + weighted sum (uses the legs' actual relevance
   * magnitudes). Reuses vectorWeight/keywordWeight/ftsWeight as the linear weights.
   */
  fusion?: FusionMethod;
  /**
   * Per-leg score normalization for linear fusion: "minmax" (default) or "l2". Ignored when
   * fusion is "rrf".
   */
  fusionNormalizer?: FusionNormalizer;
```

Ensure `FusionMethod` and `FusionNormalizer` are in scope — they are declared in the same file (Task 3, Step 3), so no import is needed.

- [ ] **Step 4: Add defaults**

In `src/RagPipeline.ts`, in the `DEFAULTS` object (currently ending at `rerankerMinAbsoluteScore: 0,`), add two entries:

```typescript
  fusion: "rrf",
  fusionNormalizer: "minmax",
```

(Do **not** add them to the `Omit<…>` list in the `satisfies` clause — they have defaults, like `rrfK`.)

- [ ] **Step 5: Import `applyLinearFusion` and add the fusion branch**

In `src/RagPipeline.ts`, find the existing `applyRRF` import and add the linear import beside it:

```typescript
import { applyLinearFusion } from "./linearFusion.js";
```

Then replace the `const fused = applyRRF(…)` block (the call that uses `fusedLimit`) with:

```typescript
        const legsForFusion = [
          { items: results.vectorRows },
          { items: results.keywordRows },
          { items: results.ftsRows },
        ];
        const fusionWeights = [opts.vectorWeight, opts.keywordWeight, opts.ftsWeight];
        const fused =
          opts.fusion === "linear"
            ? applyLinearFusion(legsForFusion, fusedLimit, fusionWeights, opts.fusionNormalizer)
            : applyRRF(legsForFusion, opts.rrfK, fusedLimit, fusionWeights);
        span.setAttribute("fusion", opts.fusion);
```

- [ ] **Step 6: Run the full suite to verify pass**

Run: `bun test tests/pipeline.test.ts`
Expected: PASS — both new cases green; all existing pipeline tests (RRF default, reranking, union) unchanged.

- [ ] **Step 7: Document in README**

In `README.md`, in the search-options table (the `| rrfK | … |` region), add two rows after the `rrfK` row:

```markdown
| `fusion` | `"rrf"` | Leg fusion method. `"rrf"` (default) = Reciprocal Rank Fusion (rank-only). `"linear"` = per-leg score normalization + weighted sum, using the legs' actual relevance scores (cosine, word_similarity, bm25). Reuses the `*Weight` options as linear weights. |
| `fusionNormalizer` | `"minmax"` | Per-leg normalization for `fusion: "linear"`: `"minmax"` (best→1, worst→0 within each leg) or `"l2"` (divide by the leg's score vector norm; preserves relative magnitude). Ignored for `"rrf"`. |
```

- [ ] **Step 8: Full verification**

Run: `bun test && bun run typecheck && bun run lint && bun run build`
Expected: entire suite passes; no type/lint/build errors.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/RagPipeline.ts README.md tests/pipeline.test.ts
git commit -m "feat(fusion): select linear vs rrf via per-query fusion option"
```

---

### Task 5: Benchmark wiring — `FUSION`/`NORMALIZER` env knobs + experiment script

**Files:**
- Modify: `examples/benchmark/run.ts` (read `FUSION`/`NORMALIZER`, pass to `pipeline.search`, log)
- Create: `examples/benchmark/linear_fusion_experiment.ps1`

**Interfaces:**
- Consumes: `RagSearchOptions.fusion` / `fusionNormalizer` (Task 4).
- Produces: env-driven fusion selection in the benchmark; a runnable experiment script.

Note: `examples/` is excluded from `tsc` typecheck and not part of the tsup build, and `run.ts` needs a live DB + infinity. So verification here is `bun run lint` + a read-back of the wiring; the actual measurement is the separate experiment run (post-implementation).

- [ ] **Step 1: Read the env knobs in `run.ts`**

In `examples/benchmark/run.ts`, right after the existing `const candidateMultiplier = posIntEnv("CANDIDATE_MULTIPLIER");` line, add:

```typescript
    // Fusion strategy knobs (the linear-fusion experiment). FUSION selects rrf (default) or
    // linear; NORMALIZER picks minmax (default) or l2 for the linear path. Undefined → pipeline
    // defaults (rrf / minmax), i.e. unchanged behavior.
    const fusion = process.env.FUSION === "linear" ? ("linear" as const) : undefined;
    const fusionNormalizer =
      process.env.NORMALIZER === "l2"
        ? ("l2" as const)
        : process.env.NORMALIZER === "minmax"
          ? ("minmax" as const)
          : undefined;
    if (fusion !== undefined || fusionNormalizer !== undefined) {
      console.log(
        `  Fusion: ${fusion ?? "rrf (default)"}, normalizer=${fusionNormalizer ?? "minmax (default)"}.`,
      );
    }
```

- [ ] **Step 2: Pass them to `pipeline.search`**

In `examples/benchmark/run.ts`, in the `pipeline.search(variant, { … })` options object (the one with `topK`, `rerank`, `rerankCandidates`, `candidateMultiplier`), add two more spread entries:

```typescript
          ...(fusion !== undefined ? { fusion } : {}),
          ...(fusionNormalizer !== undefined ? { fusionNormalizer } : {}),
```

- [ ] **Step 3: Lint the change**

Run: `bun run lint`
Expected: no errors. (Typecheck excludes `examples/`; do not rely on it here.)

- [ ] **Step 4: Create the experiment script**

Create `examples/benchmark/linear_fusion_experiment.ps1`:

```powershell
# Linear-fusion experiment — bge-m3, full 89q, topK=10, local GPU (2-model infinity).
# Tests two hypotheses against RRF:
#   H1: can score-aware fusion rerank a union of 20 and match RRF's union-of-30 (.789)?
#   H2: does linear fusion lift the NO-rerank path above RRF baseline (.665)?
# See docs/superpowers/specs/2026-06-22-linear-fusion-design.md. Run from repo root:
#   pwsh -NoProfile -File examples/benchmark/linear_fusion_experiment.ps1
# Prereqs: infinity up (docker-compose.infinity-min.yml, GPU) + DB up (examples-db-1).
$ErrorActionPreference = "Continue"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root
$out = "examples\benchmark\results\linear"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$sum = "$out\_summary.txt"
"LINEAR-FUSION EXPERIMENT — bge-m3, full 89q, topK=10 — $(Get-Date -Format o)" | Out-File -Encoding utf8 $sum

# Common env (bge-m3 embedder + bge-reranker, both fp16 on GPU via infinity :7997)
$env:EMBEDDING_BASE_URL="http://localhost:7997"; $env:EMBEDDING_API_KEY="local-dev-key"
$env:EMBEDDING_MODEL="BAAI/bge-m3"; $env:EMBEDDING_DIM="1024"; $env:EMBEDDING_BATCH_SIZE="32"
$env:RERANKER_BASE_URL="http://localhost:7997"; $env:RERANKER_API_KEY="local-dev-key"; $env:RERANKER_MODEL="BAAI/bge-reranker-v2-m3"
$env:SEARCH_CONCURRENCY="2"   # GPU driver crashed under heavier load; keep pressure minimal
$env:VECTOR_MIN_SCORE="0"     # do not floor the vector leg before normalization

# name | flags | FUSION | NORMALIZER | RERANK_CANDIDATES | CANDIDATE_MULTIPLIER
$runs = @(
  @{ n="rrf_base";    flags=@();          fu="rrf";    nm="";       rc="";   cm="2" },  # control, no rerank (~.665)
  @{ n="lin_base_mm"; flags=@();          fu="linear"; nm="minmax"; rc="";   cm="2" },  # H2: linear, no rerank
  @{ n="lin_base_l2"; flags=@();          fu="linear"; nm="l2";     rc="";   cm="2" },  # H2: l2 variant
  @{ n="rrf_u30";     flags=@("--rerank"); fu="rrf";    nm="";       rc="30"; cm="3" }, # control (~.789)
  @{ n="lin_u20_mm";  flags=@("--rerank"); fu="linear"; nm="minmax"; rc="20"; cm="2" }, # H1: linear@20 vs rrf@30
  @{ n="lin_u30_mm";  flags=@("--rerank"); fu="linear"; nm="minmax"; rc="30"; cm="3" }  # linear at full union depth
)

foreach ($r in $runs) {
  podman exec examples-db-1 psql -U user -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname LIKE 'arrag_bench%' AND pid <> pg_backend_pid();" 2>&1 | Out-Null
  $env:FUSION = $r.fu; $env:NORMALIZER = $r.nm
  if ($r.rc) { $env:RERANK_CANDIDATES = $r.rc } else { Remove-Item Env:RERANK_CANDIDATES -ErrorAction SilentlyContinue }
  $env:CANDIDATE_MULTIPLIER = $r.cm
  $log = "$out\$($r.n).log"
  "=== $($r.n): flags=$($r.flags -join ' ') FUSION=$($r.fu) NORM=$($r.nm) RC=$($r.rc) CM=$($r.cm) ===" | Out-File -Append -Encoding utf8 $sum
  $t = Measure-Command { bun run examples/benchmark/run.ts @($r.flags) *>&1 | Out-File -Encoding utf8 $log }
  $counts = Select-String -Path $log -Pattern 'rerankInputCount: (\d+)' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value }
  $maxc = if ($counts) { ($counts | Measure-Object -Maximum).Maximum } else { "n/a" }
  $avgc = if ($counts) { [math]::Round(($counts | Measure-Object -Average).Average,1) } else { "n/a" }
  $cmp  = (Select-String -Path $log -Pattern '^\s+(baseline|\+rerank|custom)\s' | ForEach-Object { $_.Line }) -join "`n"
  ("  elapsed {0}s | rerankInput avg={1} max={2}`n{3}" -f [math]::Round($t.TotalSeconds,1), $avgc, $maxc, $cmp) | Out-File -Append -Encoding utf8 $sum
}
"LINEAR EXPERIMENT DONE" | Out-File -Append -Encoding utf8 $sum
Write-Output "Done. Summary: $out\_summary.txt"
```

- [ ] **Step 5: Commit**

```bash
git add examples/benchmark/run.ts examples/benchmark/linear_fusion_experiment.ps1
git commit -m "feat(benchmark): FUSION/NORMALIZER knobs + linear-fusion experiment"
```

---

## Self-Review

**Spec coverage:**
- Score plumbing → Task 1. ✓
- `src/linearFusion.ts` + normalizers + edge rules → Task 3. ✓
- `src/fusionShared.ts` extraction, RRF unchanged → Task 2. ✓
- Options + defaults → Task 4. ✓
- Public API export → Task 3, Step 5. ✓
- Benchmark wiring + experiment configs (H1/H2) → Task 5. ✓
- Tests (normalizer math, dedup, degenerate legs, rrf-unchanged, score plumbing, pipeline branch) → Tasks 1–4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the command + expected outcome.

**Type consistency:** `applyLinearFusion(legs, topK, weights?, normalizer?)` is defined identically in Task 3 (impl), Task 4 (call site, `applyLinearFusion(legsForFusion, fusedLimit, fusionWeights, opts.fusionNormalizer)`), and Task 5 (env-driven). `FusionMethod`/`FusionNormalizer` declared in `types.ts` (Task 3) and consumed in `RagSearchOptions` (Task 4) and `linearFusion.ts` (Task 3). `toRagResult(candidate, score)` / `parseMetadata` defined in Task 2, consumed by `rrf.ts` (Task 2) and `linearFusion.ts` (Task 3). `RankedCandidate.score?: number` defined in Task 1, consumed in Task 3.
