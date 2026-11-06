# Rerank results with a cross-encoder

This guide shows how to connect a cross-encoder reranking service, choose how many fused candidates it scores, and drop unrelated results after reranking. Reranking reorders the fused candidates by a model that reads the query and each chunk together; it costs one model call per search.

For why reranking a bounded union of candidates helps, and how the cutoffs behave, see [Fusion and reranking](/explanation/fusion-and-reranking).

## Before you begin

You need a reranking service reachable over HTTP, such as a self-hosted cross-encoder behind a Cohere-style `/rerank` endpoint or Hugging Face Text Embeddings Inference (TEI). The reranker reads text only, so it is independent of your embedding model.

## Implement a RerankerProvider

The pipeline calls `rerank(query, results, topN)`:

| Argument | What the pipeline passes |
| --- | --- |
| `query` | The query lowercased, with trailing punctuation stripped and the per-search `normalizer` applied. Stop words are kept; the lexical normalizer and segmenter are not applied. |
| `results` | The fused candidates, best first: up to `max(topK, rerankCandidates)` of them. |
| `topN` | `topK` |

Return the results with `score` set to the reranker's score. Keep the other fields (`content`, `sourceId`, `metadata`, `attributes`) by spreading the input result. The pipeline sorts what you return by `score`, applies the cutoffs below and keeps the first `topK`, so a provider that ignores `topN` or returns results out of order still yields at most `topK` results.

This provider calls a Cohere-style endpoint that takes `{ model, query, documents }` and returns `{ results: [{ index, relevance_score }] }`. Infinity and several hosted APIs use this shape; check your service's documentation for its exact path and fields.

```ts
import type { RagResult, RerankerProvider } from "pg-hybrid-rag";

export function createReranker(baseUrl: string, model: string, apiKey?: string): RerankerProvider {
  return {
    async rerank(query, results, topN) {
      const res = await fetch(`${baseUrl}/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, query, documents: results.map((r) => r.content) }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Reranker returned ${res.status}`);
      const body = (await res.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
      };
      // The response order is not guaranteed; map scores back by index.
      const scored: RagResult[] = [];
      for (const r of body.results ?? []) {
        const original = results[r.index];
        if (original) scored.push({ ...original, score: r.relevance_score });
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, topN);
    },
  };
}
```

For TEI, the request body is `{ query, texts }` and the response is an array of `{ index, score }`. This shape comes from TEI's API, not from this library; confirm it against the TEI version you run:

```ts
import type { RerankerProvider } from "pg-hybrid-rag";

const teiReranker: RerankerProvider = {
  async rerank(query, results, topN) {
    const res = await fetch("http://localhost:8080/rerank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, texts: results.map((r) => r.content), truncate: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Reranker returned ${res.status}`);
    const ranked = (await res.json()) as Array<{ index: number; score: number }>;
    return ranked
      .filter((r) => results[r.index] !== undefined)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map((r) => ({ ...results[r.index], score: r.score }));
  },
};
```

If your service caps the number of documents per request, split `results` into batches, score each batch, and map each batch's indexes back to its own slice before you merge and sort.

## Attach the reranker and enable it

Pass the provider to the pipeline, then set `rerank: true` on each search that should use it.

```ts
import { RagPipeline, type RerankerProvider } from "pg-hybrid-rag";

declare const reranker: RerankerProvider;

const pipeline = new RagPipeline({ tenantId, db, embedder, reranker });

const results = await pipeline.search("how do I change my billing address", {
  language: "en",
  rerank: true,
});
```

Both are required. `rerank: true` on a pipeline without a `reranker` silently skips reranking.

## Rerank a deeper candidate set

By default the reranker scores only the fused top `topK`. Set `rerankCandidates` to let it score more fused candidates; the search still returns at most `topK`. This lets the reranker promote a relevant chunk that fusion ranked just below the cut.

Each leg returns at most `topK × candidateMultiplier` rows (default multiplier `2`), so the union can be smaller than `rerankCandidates`. Raise `candidateMultiplier` with it:

```ts
await pipeline.search("how do I change my billing address", {
  language: "en",
  topK: 5,
  rerank: true,
  rerankCandidates: 20, // reranker scores up to 20 fused candidates
  candidateMultiplier: 4, // each leg returns up to 20 rows
});
```

Reranking cost grows with the number of candidates scored. Measure the quality gain against the latency on your own queries; see [Tune relevance](/how-to/tune-relevance).

## Drop unrelated results

Two cutoffs run on the reranked list. A result must clear every active one.

| Option | Default | Effect |
| --- | --- | --- |
| `rerankerMinRelativeScore` | `0.01` | Drops results scoring below this fraction of the top reranked score. Skipped when the top score is `0` or negative. Set `0` to disable. |
| `rerankerMinAbsoluteScore` | `0` (off) | Drops results scoring below this value, in the model's own units. Only values above `0` take effect. |

Score scales differ between models and servers, and some return raw logits that can be negative. The relative cutoff does not depend on the scale, which is why it is on by default. Turn on the absolute floor only after you have looked at your reranker's scores for queries with known relevant and unrelated results:

```ts
await pipeline.search("how do I change my billing address", {
  language: "en",
  rerank: true,
  rerankerMinRelativeScore: 0.05,
  rerankerMinAbsoluteScore: 0.2, // calibrate to your model first
});
```

`minRelevance` works on fused scores and runs before reranking, so it reduces the candidates the reranker sees rather than filtering its output.

## Handle reranker failures

If `rerank()` throws, the pipeline logs a `warn` ("Reranker failed, falling back to RRF results"), sets `error: true` on the `rag.rerank` span, and returns the fused candidates instead, capped at `topK`.

The pipeline sets no timeout on the reranker. Set one in your provider, as the samples above do with `AbortSignal.timeout`, so a slow service falls back instead of holding the search open.

After reranking, `RagResult.score` holds the reranker's score; without reranking, or after a fallback, it holds the fused score. Do not compare scores across the two.

## Related

- [Tune relevance](/how-to/tune-relevance)
- [Monitor searches](/how-to/observability)
- [RagPipeline reference](/reference/rag-pipeline)
- [Interfaces reference](/reference/interfaces)
- [Fusion and reranking](/explanation/fusion-and-reranking)
