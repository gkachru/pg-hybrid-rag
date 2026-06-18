# CJK Bigram-Coverage Keyword Leg — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pg_bigm CJK keyword leg contribute to RRF by scoring query-bigram coverage instead of length-biased symmetric similarity.

**Architecture:** The CJK keyword leg keeps the `gin_bigm_ops` index probe (`content =% $2`) purely for candidate generation at a low internal `pg_bigm.similarity_limit` floor, then scores each candidate by `|query∩doc bigrams| / |query bigrams|` (length-independent coverage, 0..1) and gates it with the existing `keywordMinScore`. The pg_trgm (Latin) leg is unchanged; the divergence is isolated into two named SQL builders.

**Tech Stack:** TypeScript (strict, no `any`), Bun + `bun:test`, PostgreSQL with pg_bigm (migration 009), Biome.

## Global Constraints

- **Zero runtime npm dependencies.** No tokenizers/segmenters. (CLAUDE.md)
- **All SQL parameterized** — never interpolate user input. GUC *names* are trusted constants (inlined); GUC *values* and all user data are bound. (CLAUDE.md)
- **Strict TypeScript, no `any`.** (CLAUDE.md)
- **Reuse `keywordMinScore`** — no new public config knob. (spec)
- **pg_trgm leg behavior is unchanged** — its existing tests must stay green verbatim. (spec)
- Lint with `bun run lint`; typecheck with `bun run typecheck`; tests with `bun test`.
- Commit messages: conventional-commit style, ending with the `Co-Authored-By` trailer (see steps).

---

### Task 1: Preflight — establish a green baseline on a feature branch

**Files:** none (repo state only)

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/cjk-bigram-coverage
```

- [ ] **Step 2: Confirm the baseline is green**

Run:
```bash
bun test
bun run typecheck
bun run lint
```
Expected: all pass. If any failure is **unrelated** to the CJK keyword leg (e.g. a pre-existing error in `tests/indexer.test.ts` / `tests/pipeline.test.ts`), STOP and report it to the user before proceeding — do not bury an unrelated red baseline under this change. If all green, continue.

---

### Task 2: Replace CJK keyword scoring with query-bigram coverage

**Files:**
- Modify: `src/adapters/PostgresRagDatabase.ts` (keyword leg, ~lines 105–141; add a constant near line 9 and two builders before the class at line 45)
- Test: `tests/postgresRagDatabase.test.ts` (replace the two CJK SQL-shape tests at ~lines 60–67 and ~123–136; add two tests)

**Interfaces:**
- Produces (module-level in `PostgresRagDatabase.ts`):
  - `const CJK_BIGM_CANDIDATE_FLOOR = 0.001`
  - `interface KeywordLegSql { sql: string; params: unknown[]; gucs: Array<{ name: string; value: string }> }`
  - `function buildTrigramKeywordSql(params: HybridSearchParams): KeywordLegSql`
  - `function buildBigmCoverageKeywordSql(params: HybridSearchParams): KeywordLegSql`
- Consumes: `buildFilters`, `toRankedCandidate` (already imported from `./sqlHelpers.js`); `this.runTuned(client, gucs, sql, params)`.

- [ ] **Step 1: Replace the two existing CJK SQL-shape tests with coverage assertions**

In `tests/postgresRagDatabase.test.ts`, **delete** the test `"uses bigm_similarity for CJK when cjk: true"` (~lines 60–67) and the test `"CJK keyword leg uses the bigm =% operator and pg_bigm.similarity_limit"` (~lines 123–136). Replace both with:

```ts
  it("scores the CJK keyword leg by query-bigram coverage (show_bigm), not bigm_similarity", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { cjk: true }).hybridSearch({
      ...params,
      language: "ja",
    });
    const keywordLeg = calls.find((c) => c.sql.includes("show_bigm(content)"));
    expect(keywordLeg).toBeDefined();
    // Coverage = |query∩doc bigrams| / |query bigrams|, computed via show_bigm + INTERSECT.
    expect(keywordLeg?.sql).toContain("show_bigm($2)");
    expect(keywordLeg?.sql).toContain("INTERSECT");
    expect(keywordLeg?.sql).not.toContain("bigm_similarity");
  });

  it("CJK keyword leg keeps the =% index probe and sets the pg_bigm floor (not keywordMinScore)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { cjk: true }).hybridSearch({
      ...params,
      language: "ja",
    });
    const keywordLeg = calls.find((c) => c.sql.includes("show_bigm(content)"));
    expect(keywordLeg?.sql).toContain("content =% $2"); // gin_bigm_ops index probe retained
    expect(keywordLeg?.sql).toContain("score >= $4"); // coverage threshold predicate
    const setCall = calls.find(
      (c) => typeof c.sql === "string" && c.sql.includes("pg_bigm.similarity_limit"),
    );
    expect(setCall?.sql).toContain("set_config('pg_bigm.similarity_limit'");
    // The GUC is the low candidate-generation floor, NOT the relevance threshold.
    expect(setCall?.params).toContain("0.001");
    expect(setCall?.params).not.toContain(String(params.keywordMinScore));
  });

  it("CJK keyword leg binds keywordMinScore as the coverage threshold ($4)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { cjk: true }).hybridSearch({
      ...params,
      language: "ja",
    });
    const keywordLeg = calls.find((c) => c.sql.includes("show_bigm(content)"));
    expect(keywordLeg?.sql).toContain("WHERE score >= $4");
    expect(keywordLeg?.params[3]).toBe(params.keywordMinScore); // $4 === keywordMinScore (0.35)
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/postgresRagDatabase.test.ts`
Expected: FAIL — the new tests can't find `show_bigm(content)` in any leg (current CJK SQL still emits `bigm_similarity`).

- [ ] **Step 3: Add the constant, the `KeywordLegSql` type, and the two builders**

In `src/adapters/PostgresRagDatabase.ts`, after `const DEFAULT_IVFFLAT_PROBES = 10;` (line 9) add:

```ts
/**
 * Internal candidate-generation floor for the CJK bigram index probe (`content =% $2`).
 * NOT the relevance threshold — relevance is the query-bigram coverage gate (keywordMinScore).
 * Kept low so the `=%` GIN probe never excludes a doc that meets the coverage threshold for
 * realistic chunk sizes (~512-token chunks ≈ ≤~500 bigrams; a coverage-0.35 match then has
 * symmetric similarity ≳ 0.002, comfortably above this floor). Verified empirically against pg_bigm.
 */
const CJK_BIGM_CANDIDATE_FLOOR = 0.001;
```

Then immediately before `export class PostgresRagDatabase` (the doc comment at ~line 36) add:

```ts
interface KeywordLegSql {
  sql: string;
  params: unknown[];
  /** Planner GUCs applied transaction-locally before the SELECT (name is a trusted constant). */
  gucs: Array<{ name: string; value: string }>;
}

/**
 * pg_trgm keyword leg: asymmetric word-similarity, index-driven via the `<%` operator.
 * Threshold (keywordMinScore) is applied via the pg_trgm.word_similarity_threshold GUC.
 */
function buildTrigramKeywordSql(params: HybridSearchParams): KeywordLegSql {
  const baseParams: unknown[] = [params.tenantId, params.query, params.candidateLimit];
  const f = buildFilters(params, 4);
  const sql = `
          SELECT id, content, source_type, source_id, metadata,
                 word_similarity($2, content) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND $2 <% content
            ${f.clause}
          ORDER BY word_similarity($2, content) DESC
          LIMIT $3
        `;
  return {
    sql,
    params: [...baseParams, ...f.params],
    gucs: [{ name: "pg_trgm.word_similarity_threshold", value: String(params.keywordMinScore) }],
  };
}

/**
 * pg_bigm keyword leg for CJK: scores by query-bigram COVERAGE
 * (|query∩doc bigrams| / |query bigrams|) — length-independent, the pg_bigm analog of
 * pg_trgm word_similarity. The `=%` operator is demoted to a pure gin_bigm_ops index probe
 * (candidate net, gated by the low CJK_BIGM_CANDIDATE_FLOOR); coverage (>= keywordMinScore) is
 * the relevance filter AND the rank order. Query bigrams are computed once in the `q` CTE.
 */
function buildBigmCoverageKeywordSql(params: HybridSearchParams): KeywordLegSql {
  // $1 tenant, $2 query, $3 candidateLimit, $4 coverage threshold (keywordMinScore); filters from $5.
  const baseParams: unknown[] = [
    params.tenantId,
    params.query,
    params.candidateLimit,
    params.keywordMinScore,
  ];
  const f = buildFilters(params, 5);
  const sql = `
          WITH q AS (SELECT show_bigm($2) AS qb)
          SELECT id, content, source_type, source_id, metadata, score FROM (
            SELECT id, content, source_type, source_id, metadata,
                   cardinality(ARRAY(SELECT unnest(q.qb)
                                     INTERSECT
                                     SELECT unnest(show_bigm(content))))::float
                     / NULLIF(cardinality(q.qb), 0) AS score
            FROM rag_documents, q
            WHERE tenant_id = $1
              AND content =% $2
              ${f.clause}
          ) c
          WHERE score >= $4
          ORDER BY score DESC
          LIMIT $3
        `;
  return {
    sql,
    params: [...baseParams, ...f.params],
    gucs: [{ name: "pg_bigm.similarity_limit", value: String(CJK_BIGM_CANDIDATE_FLOOR) }],
  };
}
```

- [ ] **Step 4: Swap the keyword leg to use the builders**

In `hybridSearch`, replace the entire keyword-leg block (the `withConnection` callback under `// --- Keyword leg (pg_trgm or pg_bigm) ---`, ~lines 105–141) with:

```ts
      // --- Keyword leg (pg_trgm word-similarity, or pg_bigm query-bigram coverage for CJK) ---
      this.txProvider.withConnection(async (client) => {
        const leg = useBigm ? buildBigmCoverageKeywordSql(params) : buildTrigramKeywordSql(params);
        const rows = await this.runTuned(client, leg.gucs, leg.sql, leg.params);
        return rows.map(toRankedCandidate);
      }),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/postgresRagDatabase.test.ts`
Expected: PASS — including the unchanged pg_trgm tests (`word_similarity($2, content) as score`, `$2 <% content`) and the param-guard tests (the CJK leg now binds `$1..$4` + filters, all referenced).

- [ ] **Step 6: Full test suite, typecheck, lint**

Run:
```bash
bun test
bun run typecheck
bun run lint
```
Expected: all pass.

- [ ] **Step 7: Verify the new SQL executes on the live DB (the real integration test)**

Run: `bun run examples/playground.ts --cjk`
Expected: completes with the multilingual results table, and the **existing CJK queries now report `keywordCandidates > 0`** where they previously showed `0` — e.g. `退货政策` [zh], `小米手机拍照` [zh], `返品できますか` [ja]. (Mocked unit tests can't prove the SQL runs; this does.)

- [ ] **Step 8: Commit**

```bash
git add src/adapters/PostgresRagDatabase.ts tests/postgresRagDatabase.test.ts
git commit -m "$(cat <<'EOF'
feat: score CJK keyword leg by query-bigram coverage

The pg_bigm CJK keyword leg scored with symmetric bigm_similarity gated at
keywordMinScore (0.35), which is unreachable for real content (length-biased:
even a verbatim match scores ~0.047), so the leg contributed zero candidates
to RRF for every CJK query. Score by query-bigram coverage instead
(|query∩doc bigrams| / |query bigrams|) — length-independent and stably
thresholdable on the existing keywordMinScore. `=%` is demoted to a pure
gin_bigm_ops index probe at a low internal floor for candidate generation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add short CJK playground samples that showcase the keyword contribution

**Files:**
- Modify: `examples/playground.ts` (append to `PRODUCTS_ZH`, `PRODUCTS_JA`; add two entries to the `queries` array)

**Interfaces:**
- Consumes: existing `PRODUCTS_ZH`, `PRODUCTS_JA`, and the `queries` array shape `{ q; lang; desc; languages? }`.

- [ ] **Step 1: Append one short ZH product and one short JA product**

In `examples/playground.ts`, add to the `PRODUCTS_ZH` array:

```ts
  {
    id: "00000000-0000-0000-0000-000000000043",
    name: "小米手环9",
    brand: "小米",
    text: `小米手环9 智能运动手环。1.62英寸AMOLED彩色屏幕，50米防水，标准模式续航长达21天。支持150种运动模式，全天候心率与血氧监测。价格：¥249。颜色：曜石黑、象牙白。`,
  },
```

And to the `PRODUCTS_JA` array:

```ts
  {
    id: "00000000-0000-0000-0000-000000000053",
    name: "シャープ 加湿空気清浄機 KI-NX75",
    brand: "シャープ",
    text: `シャープ 加湿空気清浄機 KI-NX75。プラズマクラスター搭載で空気を浄化。31畳まで対応、PM2.5対応の高性能フィルター。価格：¥49,800。`,
  },
```

- [ ] **Step 2: Add two exact-substring CJK queries**

In the `queries` array, in the Chinese / Japanese section, add:

```ts
      { q: "小米手环防水续航", lang: "zh", desc: "ZH short-title exact (pg_bigm coverage)" },
      { q: "加湿空気清浄機", lang: "ja", desc: "JA short-title exact (pg_bigm coverage)" },
```

- [ ] **Step 3: Run the playground and confirm the keyword leg dominates these queries**

Run: `bun run examples/playground.ts --cjk`
Expected: the new queries return their short product as the top hit, with `keywordCandidates >= 1` (the query terms — 小米手环/防水/续航, 加湿空気清浄機 — are exact substrings, so coverage is high). Whole run still exits 0.

- [ ] **Step 4: Commit**

```bash
git add examples/playground.ts
git commit -m "$(cat <<'EOF'
test: add short CJK playground samples for pg_bigm coverage demo

Short product titles + exact-substring queries make the CJK keyword leg's
contribution unmistakable (keywordCandidates jumps from 0 to N).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Update CLAUDE.md to describe coverage scoring

**Files:**
- Modify: `CLAUDE.md` (the "Keyword" architecture bullet and the "Index-driving keyword search + per-query planner GUCs" design-patterns bullet)

- [ ] **Step 1: Update the two CLAUDE.md references to the CJK keyword leg**

Replace the architecture line:
```
2. **Keyword** — pg_trgm `word_similarity` on `content` (or pg_bigm `bigm_similarity` for CJK)
```
with:
```
2. **Keyword** — pg_trgm `word_similarity` on `content` (or pg_bigm query-bigram coverage for CJK)
```

In the "Index-driving keyword search + per-query planner GUCs" bullet, replace the pg_bigm clause:
```
   pg_bigm: `content =% $2` ≡ bigm_similarity(...) >= pg_bigm.similarity_limit
```
with a sentence describing the new shape (keep the pg_trgm description intact):
```
For CJK, pg_bigm uses `content =% $2` purely as a gin_bigm_ops candidate probe (gated by a low internal `pg_bigm.similarity_limit` floor), then scores/filters by query-bigram coverage (`|query∩doc bigrams| / |query bigrams|` via `show_bigm`) against `keywordMinScore` — length-independent, unlike symmetric `bigm_similarity`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: describe CJK query-bigram coverage in CLAUDE.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Coverage scoring SQL → Task 2 (Step 3 `buildBigmCoverageKeywordSql`). ✓
- `=%` demoted to index probe at low floor → Task 2 (`CJK_BIGM_CANDIDATE_FLOOR = 0.001`, gucs). ✓
- Reuse `keywordMinScore`, no new API → Task 2 ($4 bound = keywordMinScore; no type/config change). ✓
- Two named builders, pg_trgm untouched → Task 2 (Steps 3–4; pg_trgm tests unchanged). ✓
- Tests: update 3 CJK tests, add coverage/threshold/param-guard assertions → Task 2 (Step 1); param-guard test at ~line 231 still passes (noted in Step 5). ✓
- `=%` floor recall risk verified → resolved empirically (floor 0.001 pinned) and re-checked live in Task 2 Step 7. ✓
- Minimal playground samples → Task 3. ✓
- Docs → Task 4. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output. ✓

**3. Type consistency:** `KeywordLegSql { sql; params; gucs }` produced in Task 2 and consumed by the swapped leg via `leg.gucs/leg.sql/leg.params` into `runTuned(client, gucs, sql, params)` (matches the private signature at `PostgresRagDatabase.ts:197`). Builders take `HybridSearchParams` (imported). `buildFilters(params, 4|5)` and `toRankedCandidate` match `sqlHelpers.ts`. ✓
