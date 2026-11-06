# Tune search relevance

This guide shows how to measure search quality on your own queries and adjust the thresholds, leg weights, fusion method and candidate pool. Every default is a starting point; validate changes on your corpus and embedding model before you ship them.

For how the legs are fused and what each knob does to the ranking, see [Fusion and reranking](/explanation/fusion-and-reranking).

## The knobs

All of these are `search()` options.

| Option | Default | Effect |
| --- | --- | --- |
| `topK` | `5` | Results returned |
| `candidateMultiplier` | `2` | Each leg returns up to `topK × candidateMultiplier` rows before fusion |
| `vectorMinScore` | `0.8` | Minimum cosine similarity for the vector leg |
| `keywordMinScore` | `0.35` | Minimum pg_trgm word similarity for the keyword leg (bigram coverage on the CJK pg_bigm path) |
| `vectorWeight`, `keywordWeight`, `ftsWeight` | `1` each | Per-leg weight in fusion; `0` disables the leg |
| `fusion` | `"rrf"` | `"rrf"` (rank-based) or `"linear"` (normalized scores, weighted sum) |
| `rrfK` | `60` | RRF smoothing constant; ignored by linear fusion |
| `fusionNormalizer` | `"minmax"` | Per-leg normalization for linear fusion: `"minmax"` or `"l2"` |
| `minRelevance` | unset | Drops fused results below this fraction of the top fused score |

Reranking options are covered in [Rerank results](/how-to/rerank).

## Build an evaluation set

Collect real queries with the documents a correct answer should come from. A few dozen queries that reflect what users ask is enough to catch large regressions; you need more to see small effects. Record the query language with each one.

```json
[
  { "query": "how do I change my billing address", "language": "en", "relevant": ["7d1c0f9a-2b8e-4c4f-9a51-0e6f3b2d8c11"] },
  { "query": "cambiar dirección de facturación", "language": "es", "relevant": ["7d1c0f9a-2b8e-4c4f-9a51-0e6f3b2d8c11", "4b0e2a77-91d3-4d6e-8f20-5c9a1e3b7f42"] }
]
```

Use source IDs rather than chunk text as the relevance labels, so the labels survive re-chunking.

## Measure recall@k and MRR

Two metrics cover most decisions:

- **recall@k**: the share of a query's relevant sources found in the top k, averaged over queries.
- **MRR** (mean reciprocal rank): `1 / rank` of the first relevant source, averaged over queries; `0` when none is found.

```ts
import type { RagPipeline, RagSearchOptions } from "pg-hybrid-rag";

interface EvalCase {
  query: string;
  language: string;
  relevant: string[]; // source IDs
}

async function evaluate(
  p: RagPipeline,
  cases: EvalCase[],
  options: RagSearchOptions,
  k = 5,
): Promise<{ recallAtK: number; mrr: number }> {
  let recallSum = 0;
  let rrSum = 0;
  for (const c of cases) {
    const results = await p.search(c.query, { ...options, language: c.language, topK: k });
    // Several chunks can come from one source; rank sources by first appearance.
    const ranked = [...new Set(results.map((r) => r.sourceId))];
    const relevant = new Set(c.relevant);
    const isRelevant = (id: string | null) => id !== null && relevant.has(id);
    recallSum += ranked.filter(isRelevant).length / relevant.size;
    const first = ranked.findIndex(isRelevant);
    rrSum += first === -1 ? 0 : 1 / (first + 1);
  }
  return { recallAtK: recallSum / cases.length, mrr: rrSum / cases.length };
}

declare const cases: EvalCase[];

const baseline = await evaluate(pipeline, cases, {});
const candidate = await evaluate(pipeline, cases, { vectorMinScore: 0.5 });
console.log({ baseline, candidate });
```

Work in this order:

1. Run the baseline and save the numbers.
2. Change one option, re-run, and compare.
3. Keep the change only if it helps the metric you care about and does not hurt any important query group, such as one language or one product area.
4. Re-run the whole set after any change to the embedding model, chunking, migrations or extension versions.

On a small set, a difference of one or two queries is noise. The repository's [benchmark harness](https://github.com/gkachru/pg-hybrid-rag/tree/main/examples/benchmark) shows a fuller version of this method, with committed baselines and a regression check.

## Calibrate vectorMinScore for your embedder

The default `0.8` suits e5-family models, whose cosine scores sit high. Many other models, such as `bge-m3`, score relevant chunks lower, and `0.8` then drops most of the vector leg without any error. `recommendForLanguage(code).vectorMinScore` gives `0.4` as a starting point for `bge-m3`.

To see the raw cosine scores, call the adapter's `hybridSearch` with the floor at `0` and look at where relevant and unrelated chunks land:

```ts
const embedding = await embedder.embedQuery(query.toLowerCase());

const { vectorRows } = await db.hybridSearch({
  tenantId,
  embeddingStr: `[${embedding.join(",")}]`,
  query,
  synonymLookup: new Map(),
  language: "en",
  candidateLimit: 20,
  vectorMinScore: 0,
  keywordMinScore: 0.35,
});

for (const row of vectorRows) {
  console.log(row.score?.toFixed(3), row.sourceId, row.content.slice(0, 60));
}
```

Run this for a sample of your evaluation queries. Set `vectorMinScore` just below the scores of most relevant chunks, then confirm with `evaluate()`. A lower floor admits weaker matches into fusion, so check that precision holds.

## Adjust leg weights

Weights scale each leg's contribution in both fusion methods.

```ts
// Codes, SKUs and exact names: favor the lexical legs
await pipeline.search("SKU-4471-B", { language: "en", keywordWeight: 2, ftsWeight: 1.5 });

// Natural-language questions: favor the vector leg
await pipeline.search("why was I charged twice this month", { language: "en", vectorWeight: 2 });
```

A weight of exactly `0` disables the leg. `PostgresRagDatabase` skips that leg's query without taking a connection, and the pipeline discards any rows a custom adapter still returns for it, so none of its candidates enter fusion. The query is still embedded when `vectorWeight` is `0`. To keep a leg's candidates but reduce its influence, use a small positive weight instead.

```ts
// Lexical-only search: the vector leg's SQL does not run
await pipeline.search("SKU-4471-B", { language: "en", vectorWeight: 0 });
```

## Choose a fusion method

- `fusion: "rrf"` (default) uses only each candidate's rank in each leg: a leg adds `weight / (rrfK + rank)`, with rank counted from 1. A higher `rrfK` flattens the difference between ranks; a lower one favors the top of each leg.
- `fusion: "linear"` normalizes each leg's scores (`fusionNormalizer: "minmax"` maps a leg's best to 1 and worst to 0; `"l2"` divides by the leg's vector norm) and adds them with the leg weights. It uses how far apart the scores are, not just their order, so it depends on how well your embedder's scores separate relevant from unrelated chunks.

```ts
await pipeline.search(query, { language: "en", fusion: "linear", fusionNormalizer: "minmax" });
```

Evaluate both on your set; neither wins everywhere.

## Trim weak results

- `minRelevance` drops fused results below a fraction of the top fused score. `0.5` keeps results scoring at least half the best one. It applies before reranking.
- `keywordMinScore` sets how similar a chunk's words must be to the query for the keyword leg. Raise it to cut fuzzy matches; lower it to catch misspellings and partial words.
- With reranking, use the reranker cutoffs instead; see [Rerank results](/how-to/rerank#drop-unrelated-results).

## Widen the candidate pool

Fusion only sees what each leg returns. A larger `candidateMultiplier` lets a chunk that ranks moderately in two legs collect score from both. It also adds database work per search. Raise it when you rerank a deeper candidate set, or when recall@k improves on your set.

## Related

- [Rerank results](/how-to/rerank)
- [Configure embeddings](/how-to/configure-embeddings)
- [Manage stop words and synonyms](/how-to/stop-words-and-synonyms)
- [RagPipeline reference](/reference/rag-pipeline)
- [Fusion and reranking](/explanation/fusion-and-reranking)
