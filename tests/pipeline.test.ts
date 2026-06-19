import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { RagDatabase, RerankerProvider } from "../src/interfaces.js";
import { RagPipeline } from "../src/RagPipeline.js";
import type { RagResult } from "../src/types.js";

const mockEmbedQuery = mock(() => Promise.resolve(new Array(384).fill(0.5)));
const mockEmbedder = {
  embedQuery: mockEmbedQuery,
  embedDocuments: mock(() => Promise.resolve([])),
};

const defaultVectorRows = [
  {
    content: "Return policy: 30 days",
    sourceType: "faq",
    sourceId: "faq-1",
    metadata: '{"category":"returns"}',
  },
  {
    content: "Shipping takes 3-5 days",
    sourceType: "faq",
    sourceId: "faq-2",
    metadata: "{}",
  },
];

const defaultKeywordRows = [
  {
    content: "Return policy: 30 days",
    sourceType: "faq",
    sourceId: "faq-1",
    metadata: '{"category":"returns"}',
  },
];

let vectorRows = [...defaultVectorRows];
let keywordRows = [...defaultKeywordRows];
let ftsRows: typeof defaultVectorRows = [];
let lastSearchParams: Record<string, unknown> = {};

// RRF dedups by the chunk `id`. These fixtures identify a chunk by its sourceId
// (the same chunk shares a sourceId across legs; distinct chunks differ), so derive
// a stable id from it — falling back to a per-row key when sourceId is null.
const withIds = (rows: typeof defaultVectorRows) =>
  rows.map((r, i) => ({ ...r, id: r.sourceId ?? `null-${i}` }));

const mockDb: RagDatabase = {
  hybridSearch: mock(async (params) => {
    lastSearchParams = params;
    return {
      vectorRows: withIds([...vectorRows]),
      keywordRows: withIds([...keywordRows]),
      ftsRows: withIds([...ftsRows]),
    };
  }),
  insertChunks: mock(async () => {}),
  deleteBySource: mock(async () => {}),
  replaceSource: mock(async () => {}),
};

describe("RagPipeline", () => {
  let pipeline: RagPipeline;

  beforeEach(() => {
    vectorRows = [...defaultVectorRows];
    keywordRows = [...defaultKeywordRows];
    ftsRows = [];
    lastSearchParams = {};
    mockEmbedQuery.mockClear();
    (mockDb.hybridSearch as ReturnType<typeof mock>).mockClear();
    pipeline = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
    });
  });

  it("should embed query and return hybrid search results", async () => {
    const results = await pipeline.search("return policy", { language: "en" });
    expect(mockEmbedQuery).toHaveBeenCalledWith("return policy");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe("Return policy: 30 days");
    expect(results[0].sourceType).toBe("faq");
    expect(results[0].metadata).toEqual({ category: "returns" });
  });

  it("should pass tenantId and language to db.hybridSearch", async () => {
    await pipeline.search("test", { language: "fr" });
    expect(lastSearchParams.tenantId).toBe("tenant-1");
    expect(lastSearchParams.language).toBe("fr");
    expect(lastSearchParams.query).toBe("test");
  });

  it("throws when no explicit query language is provided", async () => {
    // The implicit "en" default was removed (CODE_REVIEW #12): callers must declare the
    // query language so a non-English corpus isn't silently stemmed/scoped as English.
    await expect(pipeline.search("test")).rejects.toThrow(/language/);
  });

  it("should return empty array when no results from all legs", async () => {
    vectorRows = [];
    keywordRows = [];
    ftsRows = [];
    const results = await pipeline.search("nonexistent topic", { language: "en" });
    expect(results).toHaveLength(0);
  });

  it("should parse null metadata as empty object", async () => {
    vectorRows = [
      {
        content: "test",
        sourceType: "doc",
        sourceId: null as unknown as string,
        metadata: null as unknown as string,
      },
    ];
    keywordRows = [];
    ftsRows = [];
    const results = await pipeline.search("test", { language: "en" });
    expect(results[0].metadata).toEqual({});
  });

  it("document in both legs ranks higher than single-leg document", async () => {
    vectorRows = [
      { content: "Both legs doc", sourceType: "faq", sourceId: "f-1", metadata: "{}" },
      { content: "Vector only doc", sourceType: "faq", sourceId: "f-2", metadata: "{}" },
    ];
    keywordRows = [
      { content: "Both legs doc", sourceType: "faq", sourceId: "f-1", metadata: "{}" },
      { content: "Keyword only doc", sourceType: "faq", sourceId: "f-3", metadata: "{}" },
    ];
    ftsRows = [];
    const results = await pipeline.search("test", { language: "en" });
    expect(results[0].content).toBe("Both legs doc");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("respects custom topK option", async () => {
    vectorRows = [
      { content: "A", sourceType: "faq", sourceId: "1", metadata: "{}" },
      { content: "B", sourceType: "faq", sourceId: "2", metadata: "{}" },
      { content: "C", sourceType: "faq", sourceId: "3", metadata: "{}" },
    ];
    keywordRows = [];
    ftsRows = [];
    const results = await pipeline.search("test", { topK: 2, language: "en" });
    expect(results).toHaveLength(2);
  });

  it("passes sourceTypes to db.hybridSearch", async () => {
    await pipeline.search("test", { sourceTypes: ["product", "faq"], language: "en" });
    expect(lastSearchParams.sourceTypes).toEqual(["product", "faq"]);
  });

  it("passes languages to db.hybridSearch", async () => {
    await pipeline.search("test", { languages: ["en", "hi"], language: "en" });
    expect(lastSearchParams.languages).toEqual(["en", "hi"]);
  });

  it("omits languages when not specified", async () => {
    await pipeline.search("test", { language: "en" });
    expect(lastSearchParams.languages).toBeUndefined();
  });

  it("infers query language from a single-entry languages filter when language is unset", async () => {
    await pipeline.search("test", { languages: ["es"] });
    expect(lastSearchParams.language).toBe("es");
  });

  it("throws for a multi-entry languages filter without an explicit language", async () => {
    // A multi-entry filter is ambiguous for query stemming — require an explicit `language`.
    await expect(pipeline.search("test", { languages: ["en", "hi"] })).rejects.toThrow(/language/);
  });

  it("explicit language takes precedence over a single-entry languages filter", async () => {
    await pipeline.search("test", { languages: ["es"], language: "fr" });
    expect(lastSearchParams.language).toBe("fr");
  });

  it("applies normalizer with the inferred language from a single-entry languages filter", async () => {
    const normalizeCall: string[] = [];
    const mockNormalizer = {
      normalize: (text: string, lang: string) => {
        normalizeCall.push(`${text}|${lang}`);
        return text;
      },
    };
    await pipeline.search("hola", { normalizer: mockNormalizer, languages: ["es"] });
    expect(normalizeCall.length).toBe(1);
    expect(normalizeCall[0]).toContain("|es");
  });

  it("passes a synonymLookup to db.hybridSearch", async () => {
    await pipeline.search("test", { language: "en" });
    expect(lastSearchParams.synonymLookup).toBeInstanceOf(Map);
  });

  it("loads synonyms into the lookup when a provider is set", async () => {
    const synonyms = {
      load: mock(async () => new Map([["en", new Map([["phones", ["smartphones"]]])]])),
      invalidate: mock(() => {}),
    };
    const pipelineWithSyn = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      synonyms,
    });
    await pipelineWithSyn.search("phones", { language: "en" });
    const lookup = lastSearchParams.synonymLookup as Map<string, Map<string, string[]>>;
    expect(lookup.get("en")?.get("phones")).toEqual(["smartphones"]);
  });

  it("minRelevance drops results below threshold relative to top score", async () => {
    vectorRows = [
      { content: "Top match", sourceType: "product", sourceId: "1", metadata: "{}" },
      { content: "Weak match", sourceType: "product", sourceId: "2", metadata: "{}" },
    ];
    keywordRows = [{ content: "Top match", sourceType: "product", sourceId: "1", metadata: "{}" }];
    ftsRows = [];
    const results = await pipeline.search("test", { minRelevance: 0.8, language: "en" });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Top match");
  });

  it("FTS leg results appear in RRF fusion", async () => {
    vectorRows = [];
    keywordRows = [];
    ftsRows = [{ content: "FTS only doc", sourceType: "faq", sourceId: "fts-1", metadata: "{}" }];
    const results = await pipeline.search("test", { language: "en" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("FTS only doc");
  });

  it("documents appearing in all 3 legs rank highest", async () => {
    vectorRows = [
      { content: "All three", sourceType: "faq", sourceId: "1", metadata: "{}" },
      { content: "Vector only", sourceType: "faq", sourceId: "2", metadata: "{}" },
    ];
    keywordRows = [
      { content: "All three", sourceType: "faq", sourceId: "1", metadata: "{}" },
      { content: "Keyword only", sourceType: "faq", sourceId: "3", metadata: "{}" },
    ];
    ftsRows = [
      { content: "All three", sourceType: "faq", sourceId: "1", metadata: "{}" },
      { content: "FTS only", sourceType: "faq", sourceId: "4", metadata: "{}" },
    ];
    const results = await pipeline.search("test", { language: "en" });
    expect(results[0].content).toBe("All three");
    const singleLegDocs = results.filter((r) => r.content !== "All three");
    for (const doc of singleLegDocs) {
      expect(results[0].score).toBeGreaterThan(doc.score);
    }
  });

  it("3-way weight configuration works", async () => {
    vectorRows = [{ content: "V doc", sourceType: "faq", sourceId: "1", metadata: "{}" }];
    keywordRows = [{ content: "K doc", sourceType: "faq", sourceId: "2", metadata: "{}" }];
    ftsRows = [{ content: "F doc", sourceType: "faq", sourceId: "3", metadata: "{}" }];

    const heavyVector = await pipeline.search("test", {
      vectorWeight: 5,
      keywordWeight: 0.1,
      ftsWeight: 0.1,
      language: "en",
    });
    expect(heavyVector[0].content).toBe("V doc");

    const heavyFts = await pipeline.search("test", {
      vectorWeight: 0.1,
      keywordWeight: 0.1,
      ftsWeight: 5,
      language: "en",
    });
    expect(heavyFts[0].content).toBe("F doc");
  });

  it("normalizer applied when normalizer + language provided", async () => {
    const normalizeCall: string[] = [];
    const mockNormalizer = {
      normalize: (text: string, lang: string) => {
        normalizeCall.push(`${text}|${lang}`);
        return text.replace("thnx", "thanks");
      },
    };
    await pipeline.search("thnx for help", {
      normalizer: mockNormalizer,
      language: "en",
    });
    expect(normalizeCall.length).toBe(1);
    expect(normalizeCall[0]).toContain("thnx for help");
    expect(mockEmbedQuery).toHaveBeenCalledWith("thanks for help");
  });

  it("fallback to original if normalization empties query", async () => {
    const mockNormalizer = { normalize: () => "   " };
    const results = await pipeline.search("test query", {
      normalizer: mockNormalizer,
      language: "en",
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it("normalizer-empty fallback restores the normalized query, not the raw query", async () => {
    // When the normalizer empties the query, the lexical legs must fall back to the
    // lowercased/punctuation-stripped form ("test query"), NOT the raw query ("Test Query!").
    const mockNormalizer = { normalize: () => "" };
    await pipeline.search("Test Query!", { normalizer: mockNormalizer, language: "en" });
    expect(lastSearchParams.query).toBe("test query");
  });

  it("stop words are applied to the lexical legs but not the vector-leg embedding", async () => {
    const stopWords = {
      load: mock(async () => new Map([["en", new Set(["the", "in", "a"])]])),
      invalidate: mock(() => {}),
    };
    const pipelineWithStops = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      stopWords,
    });
    await pipelineWithStops.search("the best phone in a store", { language: "en" });
    // Vector leg embeds the natural-language query — stop words preserved for dense retrieval
    expect(mockEmbedQuery).toHaveBeenCalledWith("the best phone in a store");
    // Keyword + FTS legs receive the stop-word-stripped query
    expect(lastSearchParams.query).toBe("best phone store");
  });

  it("vector-leg embedding keeps normalizer output but not stop-word removal", async () => {
    const stopWords = {
      load: mock(async () => new Map([["en", new Set(["for"])]])),
      invalidate: mock(() => {}),
    };
    const mockNormalizer = {
      normalize: (text: string) => text.replace("thnx", "thanks"),
    };
    const pipelineWithStops = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      stopWords,
    });
    await pipelineWithStops.search("thnx for help", { normalizer: mockNormalizer, language: "en" });
    // Embedding: normalizer applied ("thnx"→"thanks"), stop word "for" preserved
    expect(mockEmbedQuery).toHaveBeenCalledWith("thanks for help");
    // Lexical legs: normalized AND stop word "for" removed
    expect(lastSearchParams.query).toBe("thanks help");
  });

  it("falls back to original query when all words are stop words", async () => {
    const stopWords = {
      load: mock(async () => new Map([["en", new Set(["the", "a", "an"])]])),
      invalidate: mock(() => {}),
    };
    const pipelineWithStops = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      stopWords,
    });
    await pipelineWithStops.search("the a an", { language: "en" });
    expect(mockEmbedQuery).toHaveBeenCalledWith("the a an");
  });

  it("stop-word fallback restores the normalized query, not the raw query", async () => {
    // When stop-word removal empties the query, the lexical legs must fall back to the
    // normalized form ("the dog"), NOT the raw query ("The Dog!") — otherwise the trigram
    // leg matches against un-lowercased, punctuation-bearing text and loses recall.
    const stopWords = {
      load: mock(async () => new Map([["en", new Set(["the", "dog"])]])),
      invalidate: mock(() => {}),
    };
    const pipelineWithStops = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      stopWords,
    });
    await pipelineWithStops.search("The Dog!", { language: "en" });
    expect(lastSearchParams.query).toBe("the dog");
  });

  it("strips trailing punctuation from query words", async () => {
    await pipeline.search("phones? price!", { language: "en" });
    expect(mockEmbedQuery).toHaveBeenCalledWith("phones price");
  });

  it("strips Hindi and Arabic trailing punctuation", async () => {
    await pipeline.search("फोन। هاتف؟", { language: "hi" });
    expect(mockEmbedQuery).toHaveBeenCalledWith("फोन هاتف");
  });

  it("applies the injected normalizer to the lexical query but not the embedding", async () => {
    const pipelineWithNorm = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      // Uppercase stand-in for orthographic folding, so the effect is observable.
      normalizer: { normalize: (t: string) => t.toUpperCase() },
    });
    await pipelineWithNorm.search("alef test", { language: "ar" });
    // Lexical legs get the normalized query…
    expect(lastSearchParams.query).toBe("ALEF TEST");
    // …but the embedding sees the un-folded (natural) query.
    expect(mockEmbedQuery).toHaveBeenCalledWith("alef test");
  });

  it("awaits an async normalizer for the lexical query", async () => {
    const pipelineWithNorm = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      normalizer: { normalize: async (t: string) => `A:${t}` },
    });
    await pipelineWithNorm.search("hi", { language: "ar" });
    expect(lastSearchParams.query).toBe("A:hi");
  });

  it("no injected normalizer leaves the lexical query unchanged", async () => {
    await pipeline.search("plain query", { language: "en" });
    expect(lastSearchParams.query).toBe("plain query");
  });

  describe("reranking", () => {
    it("applies reranker when rerank=true and reranker is configured", async () => {
      const reranker = {
        rerank: mock(async (_query: string, results: unknown[], topN: number) => {
          const r = results as Array<{ content: string; score: number }>;
          return r
            .map((item) => ({ ...item, score: item.content === "B" ? 0.9 : 0.1 }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topN);
        }),
      };
      vectorRows = [
        { content: "A", sourceType: "faq", sourceId: "1", metadata: "{}" },
        { content: "B", sourceType: "faq", sourceId: "2", metadata: "{}" },
      ];
      keywordRows = [];
      ftsRows = [];

      const pipelineWithReranker = new RagPipeline({
        tenantId: "tenant-1",
        db: mockDb,
        embedder: mockEmbedder,
        reranker,
      });
      const results = await pipelineWithReranker.search("test", { rerank: true, language: "en" });
      expect(reranker.rerank).toHaveBeenCalled();
      expect(results[0].content).toBe("B");
      expect(results[0].score).toBe(0.9);
    });

    it("does not rerank when rerank=false (default)", async () => {
      const reranker = {
        rerank: mock(async (_q: string, results: unknown[]) => results),
      };
      const pipelineWithReranker = new RagPipeline({
        tenantId: "tenant-1",
        db: mockDb,
        embedder: mockEmbedder,
        reranker,
      });
      await pipelineWithReranker.search("test", { language: "en" });
      expect(reranker.rerank).not.toHaveBeenCalled();
    });

    it("gracefully degrades when reranker throws", async () => {
      const reranker = {
        rerank: mock(async () => {
          throw new Error("Reranker API down");
        }),
      };
      vectorRows = [{ content: "A", sourceType: "faq", sourceId: "1", metadata: "{}" }];
      keywordRows = [];
      ftsRows = [];
      const pipelineWithReranker = new RagPipeline({
        tenantId: "tenant-1",
        db: mockDb,
        embedder: mockEmbedder,
        reranker,
      });
      const results = await pipelineWithReranker.search("test", { rerank: true, language: "en" });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("A");
    });

    it("applies rerankerMinAbsoluteScore cutoff", async () => {
      const reranker = {
        rerank: mock(async (_q: string, results: unknown[]) => {
          const r = results as Array<{ content: string; score: number }>;
          return r.map((item, i) => ({ ...item, score: i === 0 ? 0.8 : 0.005 }));
        }),
      };
      vectorRows = [
        { content: "High", sourceType: "faq", sourceId: "1", metadata: "{}" },
        { content: "Low", sourceType: "faq", sourceId: "2", metadata: "{}" },
      ];
      keywordRows = [];
      ftsRows = [];
      const pipelineWithReranker = new RagPipeline({
        tenantId: "tenant-1",
        db: mockDb,
        embedder: mockEmbedder,
        reranker,
      });
      const results = await pipelineWithReranker.search("test", {
        rerank: true,
        rerankerMinRelativeScore: 0, // isolate the absolute floor
        rerankerMinAbsoluteScore: 0.01,
        language: "en",
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("High");
    });
  });

  describe("reranker score cutoffs", () => {
    // Reranker that assigns scores by content. Mirrors bge-reranker-v2-m3 via TEI:
    // even a strong match scores low in absolute terms (0.0711), a relevant doc lower
    // still (0.0075), and unrelated docs collapse toward zero (~2.6e-5).
    const SCORES: Record<string, number> = {
      "A relevant": 0.0711,
      "B relevant": 0.0075,
      "C noise": 0.0000263,
    };

    const rerankerWithScores = (scoreByContent: Record<string, number>): RerankerProvider => ({
      rerank: mock(async (_q: string, results: RagResult[]) =>
        results
          .map((r) => ({ ...r, score: scoreByContent[r.content] ?? 0 }))
          .sort((a, b) => b.score - a.score),
      ),
    });

    const threeDocs = () => {
      vectorRows = [
        { content: "A relevant", sourceType: "faq", sourceId: "1", metadata: "{}" },
        { content: "B relevant", sourceType: "faq", sourceId: "2", metadata: "{}" },
        { content: "C noise", sourceType: "faq", sourceId: "3", metadata: "{}" },
      ];
      keywordRows = [];
      ftsRows = [];
    };

    const pipelineWith = (reranker: RerankerProvider) =>
      new RagPipeline({ tenantId: "tenant-1", db: mockDb, embedder: mockEmbedder, reranker });

    it("relative cutoff (default) keeps relevant docs and drops only the unrelated tail", async () => {
      threeDocs();
      const results = await pipelineWith(rerankerWithScores(SCORES)).search("test", {
        rerank: true,
        language: "en",
      });
      const contents = results.map((r) => r.content);
      expect(contents).toContain("A relevant");
      expect(contents).toContain("B relevant"); // 10.6% of top → survives (the bug: 0.01 absolute dropped it)
      expect(contents).not.toContain("C noise"); // 0.037% of top → dropped
    });

    it("rerankerMinRelativeScore=0 disables the relative cutoff (keep all)", async () => {
      threeDocs();
      const results = await pipelineWith(rerankerWithScores(SCORES)).search("test", {
        rerank: true,
        rerankerMinRelativeScore: 0,
        language: "en",
      });
      expect(results).toHaveLength(3);
    });

    it("a result must clear both the relative and absolute floors", async () => {
      threeDocs();
      const results = await pipelineWith(rerankerWithScores(SCORES)).search("test", {
        rerank: true,
        rerankerMinRelativeScore: 0.01, // threshold 0.000711 → A, B pass
        rerankerMinAbsoluteScore: 0.01, // → only A clears the absolute floor
        language: "en",
      });
      expect(results.map((r) => r.content)).toEqual(["A relevant"]);
    });

    it("skips the relative cutoff when the top score is not positive (e.g. raw logits)", async () => {
      threeDocs();
      const results = await pipelineWith(
        rerankerWithScores({ "A relevant": -2.25, "B relevant": -4.82, "C noise": -9.77 }),
      ).search("test", { rerank: true, language: "en" });
      // Fraction-of-top is meaningless for negative scores → no relative drop.
      expect(results).toHaveLength(3);
    });
  });

  it("uses loadMerged when available on stop words provider", async () => {
    const loadMergedMock = mock(async () => new Set(["the", "in", "a"]));
    const stopWords = {
      load: mock(async () => new Map()),
      loadMerged: loadMergedMock,
      invalidate: mock(() => {}),
    };
    const pipelineWithMerged = new RagPipeline({
      tenantId: "tenant-1",
      db: mockDb,
      embedder: mockEmbedder,
      stopWords,
    });
    await pipelineWithMerged.search("the best phone in a store", { language: "en" });
    expect(loadMergedMock).toHaveBeenCalledWith("tenant-1");
    expect(stopWords.load).not.toHaveBeenCalled();
    // Lexical legs get the stripped query; vector leg keeps the natural query
    expect(lastSearchParams.query).toBe("best phone store");
    expect(mockEmbedQuery).toHaveBeenCalledWith("the best phone in a store");
  });
});
