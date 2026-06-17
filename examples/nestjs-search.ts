/**
 * Example: NestJS search service using pg-hybrid-rag.
 *
 * Demonstrates:
 * - Multi-language search (English, French, Hindi, CJK)
 * - Filtering by source type, source ID, and document language
 * - Cross-encoder reranking
 * - Relevance cutoff
 *
 * Assumes createRagModule() from nestjs-rag-module.ts is used for wiring.
 */

import type { RagPipeline, RagResult, RerankerProvider } from "pg-hybrid-rag";

// --- Reranker adapter (e.g. TEI-compatible cross-encoder) ---

// TEI caps texts per /rerank call (its `max_client_batch_size`, often 8). Sending more
// returns HTTP 422 — which the pipeline catches as a reranker failure and silently falls
// back to RRF order, so reranking just stops happening. Split candidates into batches,
// score each, and merge by original index. `batchSize` must be ≤ the server's limit.
function createReranker(rerankerUrl: string, batchSize = 8): RerankerProvider {
  // Returns scores aligned to the input `texts` order.
  async function scoreBatch(query: string, texts: string[]): Promise<number[]> {
    const res = await fetch(`${rerankerUrl}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, texts, truncate: true }),
    });
    if (!res.ok) throw new Error(`Reranker error ${res.status}`);
    const ranked = (await res.json()) as Array<{ index: number; score: number }>;
    const scores = new Array<number>(texts.length).fill(0);
    for (const { index, score } of ranked) scores[index] = score;
    return scores;
  }

  return {
    async rerank(query, results, topN) {
      const batches: RagResult[][] = [];
      for (let i = 0; i < results.length; i += batchSize) {
        batches.push(results.slice(i, i + batchSize));
      }
      const batchScores = await Promise.all(
        batches.map((batch) =>
          scoreBatch(
            query,
            batch.map((r) => r.content),
          ),
        ),
      );
      return batches
        .flatMap((batch, bi) => batch.map((r, j) => ({ ...r, score: batchScores[bi][j] })))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);
    },
  };
}

// --- Search service ---

class SearchService {
  constructor(private pipeline: RagPipeline) {}

  /**
   * Search across all source types.
   * Language determines which Postgres FTS stemming config is used:
   * - "en" → english (running → run)
   * - "fr" → french (courir → cour)
   * - "hi" → simple (no stemming, fuzzy matching via trigrams)
   * - "zh" → simple (no stemming, bigram matching if cjk enabled)
   */
  async search(query: string, language: string): Promise<RagResult[]> {
    return this.pipeline.search(query, {
      language,
      topK: 10,
    });
  }

  /** Search only products. */
  async searchProducts(query: string, language: string): Promise<RagResult[]> {
    return this.pipeline.search(query, {
      language,
      sourceTypes: ["product"],
      topK: 10,
    });
  }

  /** Search FAQs for a specific product. */
  async searchProductFaqs(
    query: string,
    language: string,
    productId: string,
  ): Promise<RagResult[]> {
    return this.pipeline.search(query, {
      language,
      sourceTypes: ["faq"],
      sourceIds: [productId],
      topK: 5,
    });
  }

  /** Search only within specific document languages (e.g. English + Hindi). */
  async searchInLanguages(
    query: string,
    language: string,
    languages: string[],
  ): Promise<RagResult[]> {
    return this.pipeline.search(query, {
      language,
      languages,
      topK: 10,
    });
  }

  /**
   * High-quality search with reranking and relevance cutoffs.
   * The cross-encoder reranker reorders results by query-document relevance, then the
   * relative cutoff drops the unrelated tail (anything below 1% of the top reranked score).
   */
  async searchWithReranking(query: string, language: string): Promise<RagResult[]> {
    return this.pipeline.search(query, {
      language,
      topK: 10,
      rerank: true,
      // Relative cutoff (default 0.01): drop results scoring below this fraction of the top
      // reranked score. Model-agnostic — keys off the gap between relevant and unrelated
      // results, so it works whatever scale your reranker emits. Set to 0 to disable.
      rerankerMinRelativeScore: 0.01,
      // Optional hard floor in the reranker's own score units (default 0 = off). Calibrate to
      // your model before enabling — e.g. bge-reranker-v2-m3 via TEI scores even a perfect
      // match around 0.07, so a naive 0.01 absolute floor would drop relevant results.
      // rerankerMinAbsoluteScore: 0.001,
      minRelevance: 0.6,
    });
  }

  /**
   * Tuned search for short/ambiguous queries.
   * Lower vector threshold to cast a wider net, higher candidate multiplier
   * to give RRF more material to fuse.
   */
  async searchFuzzy(query: string, language: string): Promise<RagResult[]> {
    return this.pipeline.search(query, {
      language,
      topK: 10,
      vectorMinScore: 0.6,
      keywordMinScore: 0.2,
      candidateMultiplier: 4,
    });
  }
}

export { SearchService, createReranker };

// --- Usage ---
//
// import { createRagModule } from "./nestjs-rag-module";
//
// const rag = createRagModule({ prisma, embeddingBaseUrl, embeddingApiKey, embeddingModel, logger });
// const reranker = createReranker("https://reranker.internal/v1");
//
// // Wire pipeline with reranker
// const pipeline = new RagPipeline({
//   tenantId: "default",
//   db: rag.pipeline["db"],        // or wire directly in createRagModule
//   embedder: rag.pipeline["embedder"],
//   stopWords: rag.stopWords,
//   synonyms: rag.synonyms,
//   reranker,
//   logger,
// });
//
// const search = new SearchService(pipeline);
//
// // English — Postgres stems "running" → "run" in FTS
// const enResults = await search.search("running shoes", "en");
//
// // French — Postgres stems "chaussures" → "chaussur" in FTS
// const frResults = await search.search("chaussures de course", "fr");
//
// // Hindi — uses 'simple' config (no stemming), trigram matching handles fuzzy
// const hiResults = await search.search("दौड़ने के जूते", "hi");
//
// // Chinese — uses 'simple' config, pg_bigm handles character matching (if cjk enabled)
// const zhResults = await search.search("跑步鞋", "zh");
//
// // With reranking for higher quality
// const reranked = await search.searchWithReranking("return policy for electronics", "en");
//
// // Language-scoped — only search English documents
// const enOnly = await search.searchInLanguages("battery life", "en", ["en"]);
//
// // Language-scoped — search across English and Hindi documents
// const enHi = await search.searchInLanguages("wireless headphones", "en", ["en", "hi"]);
