# Linear (score-normalized) fusion — design

**Date:** 2026-06-22
**Status:** approved (design), pending implementation plan

## Motivation

The pipeline fuses its three search legs with Reciprocal Rank Fusion (RRF), which uses
only **rank position** and discards the legs' actual relevance scores. A vector hit at
cosine 0.95 and one at 0.55 both contribute `1/(k+rank)` if they sit at the same rank.
When a leg's scores are well-calibrated — which we measured bge-m3's cosine to be (the
`vectorMinScore` floor sweep was flat/no-op, i.e. true-positive cosines cluster
predictably) — that magnitude information carries signal RRF throws away.

Elasticsearch exposes this as the `linear` retriever: per-leg score **normalization**
(`minmax`/`l2_norm`) followed by a **weighted sum**, as an alternative to its `rrf`
retriever. This spec adds the same option to pg-hybrid-rag.

Two hypotheses to measure (the reason we're building this now):

- **H1 — cheaper rerank:** does score-aware fusion let us rerank a union of **20** and
  match/beat RRF's rerank-union-of-**30** (`.789` nDCG@10)? Fewer rerank candidates = less
  cross-encoder cost, which matters on the CPU-only N1 production target.
- **H2 — skip rerank:** does linear fusion lift the **no-rerank** path far enough above
  RRF's baseline (`.665`) to make the cross-encoder optional for some deployments?

## Goals / non-goals

**Goals**
- Add linear fusion as an **opt-in** alternative to RRF, selectable per query.
- Keep the existing RRF path **behaviorally unchanged** and the default.
- Wire both into the Arabic benchmark to measure H1 and H2.

**Non-goals**
- Replacing RRF as the default (not unless the data says so, in a later change).
- Per-leg weight tuning beyond the existing `vectorWeight`/`keywordWeight`/`ftsWeight`.
- Changing leg SQL, retrieval, reranking, or the union/`rerankCandidates` mechanics.

## Architecture decision: pure function + per-query option (not an injected interface)

The codebase has two extensibility taxonomies:
- **I/O providers → construction-injected interfaces:** `SqlClient`, `EmbeddingProvider`,
  `RerankerProvider`, `FtsStrategy`, `ChunkingProvider`.
- **Pure transforms → exported functions selected inline:** `applyRRF`, `removeStopWords`,
  `stripTrailingPunctuation`, `expandQueryWithSynonyms`.

Fusion is a **pure transform** over already-fetched leg results (no I/O), so it belongs
with the `applyRRF` family. A per-query discriminator option (in the spirit of `rrfK`,
`rerankCandidates`, `candidateMultiplier`) also fits the requirement that fusion be an
*option* and lets the benchmark flip it per run — a construction-injected `FusionStrategy`
would force one fusion per pipeline instance and require wrapping the untouched RRF path
in a class.

Rejected alternatives: (B) `FusionStrategy` interface injected at construction — cleaner
OOP but breaks the function-vs-interface taxonomy and the per-run benchmarking need;
(C) standalone function with no pipeline wiring — the benchmark needs the pipeline to use it.

## Components

### 1. Score plumbing (only touch to shared code)
- `RankedCandidate` gains `score?: number` (**optional**, to keep `applyRRF`'s public
  contract non-breaking; `applyLinearFusion` defensively treats an absent score as `0`).
- `toRankedCandidate` (`src/adapters/sqlHelpers.ts`) maps `score: Number(row.score)`. Every
  leg's SQL already aliases a `score` column (vector `1 - cosine_distance`, trgm
  `word_similarity`, bigm coverage, tsvector `ts_rank_cd`, bm25 negated distance), so no
  SQL changes. `applyRRF` ignores the field → RRF behavior identical.

### 2. `src/linearFusion.ts` (new) — `applyLinearFusion(legs, fusedLimit, weights, normalizer)`
- Normalize each leg's candidate scores **independently** (within that leg's returned set).
- Weighted sum across legs by `id` (dedup); a doc absent from a leg contributes 0 from it.
  `score(doc) = Σ_leg weight_leg × normalized_leg(doc)`.
- Sort desc → slice `fusedLimit` → map to `RagResult`.
- Leg order and weight order match `applyRRF`: `[vector, keyword, fts]` ↔
  `[vectorWeight, keywordWeight, ftsWeight]`.

### 3. `src/fusionShared.ts` (new) — shared leaf helpers
Extract `parseMetadata` and the `candidate → RagResult` mapping (currently private in
`rrf.ts`) so RRF and linear share them. RRF is refactored to import these — **no change to
its fusion logic or output**, only the source of the identical leaf helpers.

### 4. Normalization (a measured knob)
Implement two normalizers, each applied per leg over its returned set:
- `"minmax"` (default): `(s - min) / (max - min)`. Worked example, cosines
  `[0.95, 0.80, 0.55]` → `[1.0, 0.625, 0.0]`.
- `"l2"`: `s / sqrt(Σ sᵢ²)`. Same input → `[0.71, 0.59, 0.41]` (preserves magnitude, no
  forced floor).
- **Edge rules:** a leg with 0 candidates contributes nothing. For `minmax`, `max == min`
  (single candidate, or all-equal) → all normalized to `1.0`. (Known sharp edge: a lone
  weak lexical hit then gets full leg-endorsement; bounded by its weight + the `fusedLimit`
  cut, and corrected by the reranker when on. Documented in code.) `l2` is well-defined for
  a single candidate (`→ 1.0`) and needs no special case.

### 5. Options + defaults (`src/types.ts`, `src/RagPipeline.ts`)
- `RagSearchOptions.fusion?: "rrf" | "linear"` — default `"rrf"`.
- `RagSearchOptions.fusionNormalizer?: "minmax" | "l2"` — default `"minmax"`.
- Both added to the `DEFAULTS` object (`RagPipeline.ts:17`) so they're defaulted via the
  existing `{ ...DEFAULTS, ...options }` merge (and thus part of the `satisfies` set, not
  the `Omit`).
- `RagPipeline.search` branches after the legs return:
  `opts.fusion === "linear" ? applyLinearFusion(legs, fusedLimit, weights, opts.fusionNormalizer) : applyRRF(legs, opts.rrfK, fusedLimit, weights)`.
  `fusedLimit` is the **same** `max(topK, rerankCandidates)` already computed — so the
  bounded-union mechanic works identically with linear fusion (this is what enables H1).
- The post-fusion `minRelevance` cutoff and the reranking stage are **unchanged** — they
  operate on whatever fused list they receive (`fused[0].score * minRelevance`).

### 6. Public API (`src/index.ts`)
Export `applyLinearFusion` and the normalizer type alongside `applyRRF`.

### 7. Benchmark wiring (`examples/benchmark/run.ts`)
- `FUSION` (`rrf`|`linear`) and `NORMALIZER` (`minmax`|`l2`) env knobs, passed through to
  `pipeline.search` like the existing `RERANK_CANDIDATES`/`CANDIDATE_MULTIPLIER` knobs.
- New experiment script `examples/benchmark/linear_fusion_experiment.ps1` with configs for
  the two hypotheses (bge-m3, full 89q, topK=10, `VECTOR_MIN_SCORE=0`, `SEARCH_CONCURRENCY=2`,
  2-model infinity — same harness/mitigations as the union experiment):

  | name | fusion | norm | rerank | RC | CM | tests |
  |---|---|---|---|---|---|---|
  | rrf_base | rrf | — | off | — | 2 | control, expect ≈ .665 |
  | lin_base_mm | linear | minmax | off | — | 2 | **H2**: no-rerank, score-aware |
  | lin_base_l2 | linear | l2 | off | — | 2 | **H2**: l2 variant |
  | rrf_u30 | rrf | — | on | 30 | 3 | control, expect ≈ .789 |
  | lin_u20_mm | linear | minmax | on | 20 | 2 | **H1**: linear@20 vs rrf@30 |
  | lin_u30_mm | linear | minmax | on | 30 | 3 | linear at full union depth |

### 8. Tests (TDD, mocked DB — no real Postgres)
- Normalizer math: minmax + l2 on a known vector; degenerate legs (empty, single,
  all-equal) hit the defined edge rules.
- Weighted-sum dedup: a doc in multiple legs sums normalized×weight correctly; weights
  applied per leg; absent-leg contributes 0; respects `fusedLimit`.
- `fusion:"rrf"` (default) output unchanged vs a baseline; `fusion:"linear"` reorders by
  normalized score as expected.
- Score plumbing: `toRankedCandidate` carries `Number(row.score)`; `applyLinearFusion`
  treats an absent score as 0.
- README options table updated for `fusion` + `fusionNormalizer`.

## Risks / edge cases
- **Scale heterogeneity across legs** (cosine 0–1, ts_rank tiny, bm25 unbounded) — handled
  by per-leg normalization; minmax fully neutralizes scale, l2 preserves within-leg
  magnitude. This is the whole reason normalization is mandatory before the weighted sum.
- **minmax degenerate `max==min`** — defined as `1.0`; flagged sharp edge above.
- **Optional `score`** — absent → treated as 0 by linear fusion (a doc with no score from a
  leg simply doesn't gain that leg's contribution). RRF unaffected.
- **No behavioral change to RRF** is a hard requirement; guarded by an explicit
  "rrf output unchanged" test and by limiting RRF's edit to importing extracted leaf helpers.

## Success criteria
- All existing tests pass; RRF path provably unchanged.
- Benchmark produces H1 (does `lin_u20_mm` ≥ `rrf_u30` .789?) and H2 (do `lin_base_mm`/
  `lin_base_l2` beat `rrf_base` ≈ .665, and by how much?) numbers, enabling a data-driven
  default decision later.
