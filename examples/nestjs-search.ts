/**
 * Example: NestJS search service using pg-hybrid-rag.
 *
 * Demonstrates:
 * - Multi-language search (English, French, Hindi, CJK)
 * - Filtering by source type and source ID
 * - Cross-encoder reranking
 * - Relevance cutoff
 *
 * Assumes createRagModule() from nestjs-rag-module.ts is used for wiring.
 */

import type { RagPipeline, RagResult, RerankerProvider } from "pg-hybrid-rag";

// --- Reranker adapter (e.g. TEI-compatible cross-encoder) ---

function createReranker(rerankerUrl: string): RerankerProvider {
  return {
    async rerank(query, results, topN) {
      const res = await fetch(`${rerankerUrl}/rerank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          texts: results.map((r) => r.content),
          truncate: true,
        }),
      });

      if (!res.ok) throw new Error(`Reranker error ${res.status}`);

      const ranked = (await res.json()) as Array<{ index: number; score: number }>;
      return ranked
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
        .map((item) => ({ ...results[item.index], score: item.score }));
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

  /**
   * High-quality search with reranking and relevance cutoff.
   * The cross-encoder reranker reorders results by query-document relevance,
   * then drops anything scoring below 60% of the top result.
   */
  async searchWithReranking(query: string, language: string): Promise<RagResult[]> {
    return this.pipeline.search(query, {
      language,
      topK: 10,
      rerank: true,
      rerankerMinScore: 0.01,
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
