# CJK keyword leg: query-bigram coverage

- **Date:** 2026-06-19
- **Status:** Design approach approved; written spec pending user review
- **Area:** `src/adapters/PostgresRagDatabase.ts` (keyword leg), playground, tests

## Problem

With `--cjk` enabled, the pg_bigm keyword leg contributes **zero** candidates for
every Chinese/Japanese query. CJK retrieval therefore rests on only the vector and
FTS legs; the keyword leg — one of the three RRF inputs — is dead weight for CJK.

## Root cause (verified on the live DB)

The CJK keyword leg scores with pg_bigm's **symmetric** `bigm_similarity($2, content)`
and gates it at `pg_bigm.similarity_limit = keywordMinScore` (**0.35**). Symmetric
bigram similarity is dominated by document length, so realistic content scores far
below 0.35 — even an exact lexical match:

| query | best doc | `bigm_similarity` (symmetric) | query-coverage |
|---|---|---|---|
| 退货政策 (appears verbatim) | zh-faq-return | 0.047 | **0.80** |
| 小米手机拍照 | zh-xiaomi | 0.032 | **0.43** |
| 无人机续航时间 | zh-drone | 0.055 | **0.50** |
| 返品できますか | ja-faq-return | 0.048 | **0.38** |

The `=%` operator only begins matching at `similarity_limit ≤ 0.02` — a fragile,
length-dependent magic number. **Every non-matching doc scored coverage 0.000**, so
query-bigram coverage cleanly separates hits from misses.

Key insight: **RRF fuses by rank, not score magnitude.** The leg's only real defect
is the threshold *scale*; the relative ordering from bigram overlap is already sound.

## Goals

- The CJK keyword leg returns candidates and ranks them sensibly, so it contributes
  to RRF fusion (visible as `keywordCandidates > 0` for CJK queries).
- Length-independent, dependency-free, works for space-less Chinese and spaced Japanese.
- No new public API; the pg_trgm (Latin) leg is unchanged.

## Non-goals

- CJK word segmentation / tokenizer dependencies (violates the zero-runtime-deps rule).
- Changing the FTS or vector legs.
- Tuning RRF weights or the relevance cutoff.

## Design

### Scoring: query-bigram coverage

Score each candidate by `|query_bigrams ∩ doc_bigrams| / |query_bigrams|` (coverage,
0..1, asymmetric toward the query — the pg_bigm analog of pg_trgm `word_similarity`).
`=%` is demoted from the scorer to a pure index probe.

Before (current):
```sql
SELECT id, content, …, bigm_similarity($2, content) AS score
FROM rag_documents
WHERE tenant_id = $1 AND content =% $2 {filters}
ORDER BY bigm_similarity($2, content) DESC
LIMIT $3
-- pg_bigm.similarity_limit := keywordMinScore (0.35)  ← unreachable
```

After:
```sql
WITH q AS (SELECT show_bigm($2) AS qb)            -- query bigrams computed once
SELECT id, content, source_type, source_id, metadata, score FROM (
  SELECT id, content, source_type, source_id, metadata,
    cardinality(ARRAY(SELECT unnest(q.qb)
                      INTERSECT
                      SELECT unnest(show_bigm(content))))::float
      / NULLIF(cardinality(q.qb), 0)              AS score   -- coverage 0..1
  FROM rag_documents, q
  WHERE tenant_id = $1
    AND content =% $2          -- gin_bigm_ops index probe (candidate net)
    {filters}
) c
WHERE score >= $N              -- coverage threshold = keywordMinScore
ORDER BY score DESC
LIMIT $3
-- pg_bigm.similarity_limit := small internal floor (candidate generation only)
```

### Threshold & public API

Reuse the existing `keywordMinScore` (default 0.35). For CJK it now gates *coverage*
on a meaningful 0..1 scale ("≥35% of the query's bigrams literally appear"). Probe
hits are 0.38–0.80, misses 0.00, so 0.35 separates them with margin. No new config knob.

### Code structure

Split the keyword leg's SQL construction into two named builders selected by `useBigm`:
- `buildTrigramKeywordSql()` — current pg_trgm behavior, verbatim.
- `buildBigmCoverageKeywordSql()` — new coverage form above.

This isolates the divergence instead of threading more ternaries through one template.

### Playground

Existing CJK queries already clear 0.35 after the fix. To make the win unmistakable,
add a small number of short, exact-substring CJK samples + matching queries (short
product titles / FAQ phrases with high coverage), so `keywordCandidates` visibly goes
0 → N. Minimal additions, not a corpus overhaul.

### Tests

- Update the 3 CJK SQL-shape tests (currently assert `bigm_similarity($2, content) as
  score` and `ORDER BY bigm_similarity … DESC`) to assert the coverage expression,
  the `score >= $N` predicate, and that the `=%` index probe is retained.
- Add: the coverage threshold is bound and referenced (the existing "no unreferenced
  parameter" guard must still pass, now that `keywordMinScore` is a bound param rather
  than the GUC value); the internal `pg_bigm.similarity_limit` floor is set
  transaction-locally via `set_config(..., true)`.
- pg_trgm leg tests stay green untouched (regression guard).

## Risks & verification

- **`=%` floor recall.** The low internal `similarity_limit` must never exclude a doc
  that *meets* the coverage threshold. High coverage ⟹ many shared bigrams ⟹ clears a
  low floor; holds for bounded-size chunks (~512-token chunker output). Verify the exact
  floor against the live DB on realistic chunk lengths. Fallback if pg_bigm's minimum
  limit is too high: keep `=%` purely as the index probe and rely on the coverage
  predicate for all filtering.
- **`show_bigm` availability.** Provided by pg_bigm (migration 009); the leg only runs
  when `cjk: true`, so the dependency is already required.
- **Per-row cost.** `show_bigm(content)` runs per candidate row, but only on the
  index-filtered candidate set (bounded by `candidateLimit`); query bigrams computed once
  via the `q` CTE.
```
