# Fusion and reranking

This page explains how the three search legs are merged into one list, why Reciprocal Rank Fusion is the default, when linear fusion is a better fit, and why the reranker scores a bounded union of candidates instead of only the final top results.

## The problem fusion solves

Each leg returns its own ranked list with its own kind of score:

| Leg | Score | Typical range |
|---|---|---|
| Vector | Cosine similarity | 0 to 1, clustered in a narrow band that depends on the embedding model |
| Keyword (pg_trgm) | `word_similarity` | 0 to 1 |
| Keyword (pg_bigm, CJK) | Query-bigram coverage | 0 to 1 |
| FTS (tsvector) | `ts_rank_cd` | Small positive numbers, no fixed upper bound |
| FTS (BM25) | BM25 score | Positive, unbounded, depends on corpus statistics |

These numbers are not comparable. A cosine of 0.82 and a `ts_rank_cd` of 0.1 say nothing about which document is more relevant. Adding them directly would let whichever leg has the largest scale decide the ranking. Fusion has to put the legs on common ground first.

The same chunk often appears in more than one leg. Both fusion methods deduplicate by the chunk's row `id`, not by its text, so two distinct chunks with identical text stay separate.

## Reciprocal Rank Fusion (the default)

RRF ignores the scores and uses only each chunk's position in each list. A chunk at rank `r` (counting from 1) in a leg with weight `w` earns `w / (rrfK + r)` from that leg, and its fused score is the sum over the legs it appears in.

With the default `rrfK` of 60 and all weights at 1:

| Chunk | Appears in | Fused score |
|---|---|---|
| C | Rank 2 in all three legs | 3/62 = 0.0484 |
| A | Rank 1 in vector, rank 3 in FTS | 1/61 + 1/63 = 0.0323 |
| B | Rank 1 in keyword only | 1/61 = 0.0164 |

Agreement between legs wins. A chunk that every leg ranks reasonably well beats a chunk that one leg ranks first and the others miss. That is the behavior you usually want from hybrid search: each leg is noisy on its own, and agreement is strong evidence.

Why RRF is the default:

- **No calibration.** It works the same whatever the embedding model, FTS strategy or corpus, because it never reads a score.
- **Robust to outliers.** One leg returning an unusually high score cannot dominate.
- **Predictable.** The contribution of each rank is fixed by `rrfK` and the weights.

The cost is that RRF discards information. A vector hit with cosine 0.95 and one with 0.55 contribute the same amount if they hold the same rank. When a leg's scores are well calibrated, that magnitude carries signal RRF throws away.

### What `rrfK` controls

`rrfK` sets how quickly credit falls off with rank. With `rrfK = 60`, rank 1 earns 1/61 and rank 10 earns 1/70, so rank 1 is worth about 1.15 times rank 10. With `rrfK = 10`, rank 1 earns 1/11 and rank 10 earns 1/20, about 1.8 times as much. A smaller `rrfK` trusts each leg's top results more; a larger one flattens the ranks and rewards agreement across legs more.

### What the weights control

`vectorWeight`, `keywordWeight` and `ftsWeight` scale each leg's contribution. With RRF, a vector weight of 2 makes a rank-1 vector hit worth as much as rank-1 hits in both lexical legs combined.

A weight of exactly 0 disables the leg. The pipeline tells the database adapter to skip it, and `PostgresRagDatabase` then runs no SQL for that leg and takes no connection for it. The pipeline also discards any rows a custom adapter returns for a skipped leg, before fusion. Skipping is better than letting the leg run with a zero contribution, for three reasons:

- **No zero-score filler.** A zero-weight leg would still add its candidates to the fused list with a score of 0. When the other legs returned fewer than `topK` chunks, those candidates would fill the remaining places even though nothing endorsed them.
- **No wasted work.** The leg's query and connection cost nothing when the leg is skipped.
- **No failure from a leg you turned off.** A leg that cannot run, for example because its extension is missing, does not fail the search when its weight is 0.

The same applies with linear fusion. The query is still embedded when `vectorWeight` is 0. Only an exact 0 disables a leg. Other values, including negative ones, are not validated and are used as given.

## Linear fusion

With `fusion: "linear"`, the pipeline normalizes each leg's scores on their own, then adds the normalized scores with the same three weights. The normalizer is selected with `fusionNormalizer`.

- **`minmax` (default)** maps each leg's scores to 0 to 1: `(s - min) / (max - min)`. Cosines `[0.95, 0.80, 0.55]` become `[1.0, 0.625, 0.0]`.
- **`l2`** divides each score by the leg's L2 norm, which keeps relative magnitudes. The same cosines become about `[0.70, 0.59, 0.40]`.

Linear fusion uses how much better one candidate is than another, not only which is ahead. That helps when the scores mean something, for example when your embedding model's cosine similarities separate relevant from irrelevant chunks cleanly.

It also has sharp edges that RRF avoids:

- **Scores are relative to each leg's candidate set.** With `minmax`, the lowest-scoring candidate in a leg always gets 0 and the highest always gets 1, however good or bad they are in absolute terms.
- **A single candidate gets full credit.** If a leg returns one row, or all its rows tie, `minmax` gives each of them 1.0. A lone weak lexical hit therefore gets the same endorsement as a strong one. The reranker, when enabled, corrects for this.
- **`l2` depends on how many candidates a leg returns.** The more rows a leg returns, the smaller each normalized score, so a leg's influence varies from query to query.

Treat linear fusion as an option to evaluate on your own queries, not as an upgrade. [Tune relevance](/how-to/tune-relevance) describes a way to compare the two.

## The relevance cutoff

`minRelevance` drops fused results that score below a fraction of the top fused score. It is relative because the absolute values are not meaningful on their own: with RRF and default weights, the highest possible fused score is 3/61, about 0.049. A cutoff of 0.5 keeps results that score at least half of the best one, whichever fusion method you use. It runs after fusion and before reranking.

## Reranking

A cross-encoder reranker reads the query and each candidate together and scores how well the candidate answers the query. It is usually more accurate than any of the three legs, because the legs compare a query and a document that were encoded or tokenized separately. It is also much slower, so it can only score a short list. The pipeline calls your `RerankerProvider` with the natural query (stop words kept, not segmented) and the fused candidates.

### Why rerank a bounded union

By default, the reranker sees only the fused top `topK`. That limits it to reordering what fusion already chose. If one leg found the right chunk but fusion ranked it sixth, a top-5 rerank never sees it.

`rerankCandidates` raises the number of fused candidates the reranker scores to `max(topK, rerankCandidates)`, and the pipeline still returns at most `topK` results. This turns fusion into a candidate generator and leaves the final ordering to the reranker. A chunk that only one leg surfaced can now reach the top if the cross-encoder agrees it is relevant.

The union is bounded by what the legs return. Each leg returns at most `topK * candidateMultiplier` rows, and the union of three legs is at most three times that, minus duplicates. With the defaults (topK 5, multiplier 2), each leg returns at most 10 rows, so a `rerankCandidates` above 30 has no effect. Raise `candidateMultiplier` along with `rerankCandidates`:

```ts
const results = await pipeline.search(query, {
  language: "en",
  rerank: true,
  rerankCandidates: 30,
  candidateMultiplier: 6, // each leg returns up to 5 * 6 = 30 rows
});
```

The trade-off is reranker cost, which grows with the number of candidates. Pick the smallest depth that recovers the results you care about on your own evaluation set.

### Score floors after reranking

Two optional floors drop reranked results; a result must clear both active floors.

- **`rerankerMinRelativeScore`** (default 0.01) drops results below that fraction of the top reranked score. Different rerankers produce very different score scales, and a fraction of the top score works across all of them without calibration. It is skipped when the top score is zero or negative, because a fraction of a negative logit has no meaning.
- **`rerankerMinAbsoluteScore`** (default 0, which means off) is a hard floor in the reranker's own units. It is useful only after you have looked at your reranker's scores on relevant and irrelevant pairs.

### When the reranker fails

If the reranker throws, the pipeline logs a warning and returns the first `topK` candidates it sent to the reranker (the fused list after any `minRelevance` cutoff), in fused order, instead of failing the search. A reranker outage then degrades quality instead of availability, and the result count stays within `topK` even when `rerankCandidates` is larger.

### What the pipeline does with reranker output

The pipeline passes `topK` to the reranker as `topN`, but it does not rely on the reranker to honor it. It applies the score floors to what the reranker returns, sorts by reranker score from highest to lowest, and keeps the first `topK`. A `RerankerProvider` therefore only has to set `score` on each result. An implementation that returns every candidate, or returns them unsorted, still produces a correct, bounded result list.

## Related

- [How hybrid search works](/explanation/hybrid-search)
- [Rerank results](/how-to/rerank)
- [Tune relevance](/how-to/tune-relevance)
- [RagPipeline reference](/reference/rag-pipeline)
