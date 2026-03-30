import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { RagDatabase } from "../src/interfaces.js";
import { RagPipeline } from "../src/RagPipeline.js";

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

const mockDb: RagDatabase = {
  hybridSearch: mock(async (params) => {
    lastSearchParams = params;
    return {
      vectorRows: [...vectorRows],
      keywordRows: [...keywordRows],
      ftsRows: [...ftsRows],
    };
  }),
  insertChunks: mock(async () => {}),
  deleteBySource: mock(async () => {}),
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
    const results = await pipeline.search("return policy");
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

  it("defaults language to en when not provided", async () => {
    await pipeline.search("test");
    expect(lastSearchParams.language).toBe("en");
  });

  it("should return empty array when no results from all legs", async () => {
    vectorRows = [];
    keywordRows = [];
    ftsRows = [];
    const results = await pipeline.search("nonexistent topic");
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
    const results = await pipeline.search("test");
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
    const results = await pipeline.search("test");
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
    const results = await pipeline.search("test", { topK: 2 });
    expect(results).toHaveLength(2);
  });

  it("passes sourceTypes to db.hybridSearch", async () => {
    await pipeline.search("test", { sourceTypes: ["product", "faq"] });
    expect(lastSearchParams.sourceTypes).toEqual(["product", "faq"]);
  });

  it("passes languages to db.hybridSearch", async () => {
    await pipeline.search("test", { languages: ["en", "hi"] });
    expect(lastSearchParams.languages).toEqual(["en", "hi"]);
  });

  it("omits languages when not specified", async () => {
    await pipeline.search("test", {});
    expect(lastSearchParams.languages).toBeUndefined();
  });

  it("minRelevance drops results below threshold relative to top score", async () => {
    vectorRows = [
      { content: "Top match", sourceType: "product", sourceId: "1", metadata: "{}" },
      { content: "Weak match", sourceType: "product", sourceId: "2", metadata: "{}" },
    ];
    keywordRows = [{ content: "Top match", sourceType: "product", sourceId: "1", metadata: "{}" }];
    ftsRows = [];
    const results = await pipeline.search("test", { minRelevance: 0.8 });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Top match");
  });

  it("FTS leg results appear in RRF fusion", async () => {
    vectorRows = [];
    keywordRows = [];
    ftsRows = [{ content: "FTS only doc", sourceType: "faq", sourceId: "fts-1", metadata: "{}" }];
    const results = await pipeline.search("test");
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
    const results = await pipeline.search("test");
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
    });
    expect(heavyVector[0].content).toBe("V doc");

    const heavyFts = await pipeline.search("test", {
      vectorWeight: 0.1,
      keywordWeight: 0.1,
      ftsWeight: 5,
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

  it("stop words are applied when provider is set", async () => {
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
    await pipelineWithStops.search("the best phone in a store");
    expect(mockEmbedQuery).toHaveBeenCalledWith("best phone store");
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
    await pipelineWithStops.search("the a an");
    expect(mockEmbedQuery).toHaveBeenCalledWith("the a an");
  });

  it("strips trailing punctuation from query words", async () => {
    await pipeline.search("phones? price!");
    expect(mockEmbedQuery).toHaveBeenCalledWith("phones price");
  });

  it("strips Hindi and Arabic trailing punctuation", async () => {
    await pipeline.search("फोन। هاتف؟");
    expect(mockEmbedQuery).toHaveBeenCalledWith("फोन هاتف");
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
      const results = await pipelineWithReranker.search("test", { rerank: true });
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
      await pipelineWithReranker.search("test");
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
      const results = await pipelineWithReranker.search("test", { rerank: true });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("A");
    });

    it("applies rerankerMinScore cutoff", async () => {
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
        rerankerMinScore: 0.01,
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("High");
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
    await pipelineWithMerged.search("the best phone in a store");
    expect(loadMergedMock).toHaveBeenCalledWith("tenant-1");
    expect(stopWords.load).not.toHaveBeenCalled();
    expect(mockEmbedQuery).toHaveBeenCalledWith("best phone store");
  });
});
