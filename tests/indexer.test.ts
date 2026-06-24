import { describe, expect, it, mock } from "bun:test";
import type { RagDatabase } from "../src/interfaces.js";
import { RagIndexer } from "../src/RagIndexer.js";

let capturedEmbedTexts: string[] = [];
let capturedInsertChunks: unknown[] = [];

const mockEmbedder = {
  embedQuery: mock(async () => [0.1, 0.2]),
  embedDocuments: mock(async (texts: string[]) => {
    capturedEmbedTexts = texts;
    return texts.map(() => [0.1, 0.2]);
  }),
};

const mockDb: RagDatabase = {
  hybridSearch: mock(async () => ({ vectorRows: [], keywordRows: [], ftsRows: [] })),
  insertChunks: mock(async (_tenantId, chunks) => {
    capturedInsertChunks = chunks;
  }),
  deleteBySource: mock(async () => {}),
  // index() now writes via replaceSource (atomic delete+insert); capture the chunk values it passes.
  replaceSource: mock(async (_tenantId, _sourceType, _sourceId, chunks) => {
    capturedInsertChunks = chunks;
  }),
};

describe("RagIndexer", () => {
  it("embeds and stores the same content text", async () => {
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db: mockDb,
      embedder: mockEmbedder,
    });

    const content = [
      "Nike Air Max 90",
      "Great running shoe",
      "Footwear",
      "Nike",
      "INR 12999",
      "running, shoes",
    ].join("\n");

    const chunks = [{ index: 0, content, metadata: { sourceType: "product", sourceId: "p-1" } }];

    capturedEmbedTexts = [];
    capturedInsertChunks = [];

    await indexer.index("product", "p-1", chunks, "en");

    expect(capturedEmbedTexts).toHaveLength(1);
    expect(capturedEmbedTexts[0]).toBe(content);

    expect(capturedInsertChunks).toHaveLength(1);
    expect((capturedInsertChunks[0] as Record<string, unknown>).content).toBe(content);

    expect(capturedEmbedTexts[0]).not.toContain("Product:");
    expect(capturedEmbedTexts[0]).not.toContain("Category:");
    expect(capturedEmbedTexts[0]).not.toContain("Brand:");
  });

  it("returns 0 for empty chunks", async () => {
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db: mockDb,
      embedder: mockEmbedder,
    });
    const result = await indexer.index("product", "p-1", [], "en");
    expect(result).toBe(0);
  });

  it("replaces the source atomically (single replaceSource call, not separate delete+insert)", async () => {
    const replaceMock = mock(async () => {});
    const insertMock = mock(async () => {});
    const deleteMock = mock(async () => {});
    const db: RagDatabase = {
      ...mockDb,
      replaceSource: replaceMock,
      insertChunks: insertMock,
      deleteBySource: deleteMock,
    };
    const indexer = new RagIndexer({ tenantId: "t-1", db, embedder: mockEmbedder });
    const chunks = [{ index: 0, content: "test", metadata: {} }];
    await indexer.index("faq", "faq-1", chunks, "en");
    expect(replaceMock).toHaveBeenCalledTimes(1);
    const [tenantId, sourceType, sourceId, values] = replaceMock.mock.calls[0];
    expect(tenantId).toBe("t-1");
    expect(sourceType).toBe("faq");
    expect(sourceId).toBe("faq-1");
    expect(values).toHaveLength(1);
    expect((values[0] as Record<string, unknown>).content).toBe("test");
    // index() no longer issues a standalone delete+insert (atomicity is the point).
    expect(insertMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("throws if the embedder returns a different number of vectors than chunks", async () => {
    const droppingEmbedder = {
      embedQuery: mock(async () => [0.1, 0.2]),
      // Drops the last text — returns one fewer vector than chunks.
      embedDocuments: mock(async (texts: string[]) => texts.slice(0, -1).map(() => [0.1, 0.2])),
    };
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db: mockDb,
      embedder: droppingEmbedder,
    });
    const chunks = [
      { index: 0, content: "one", metadata: {} },
      { index: 1, content: "two", metadata: {} },
    ];

    expect(indexer.index("product", "p-1", chunks, "en")).rejects.toThrow(
      "Embedder returned 1 embeddings for 2 chunks",
    );
  });

  it("does not write when embedding counts mismatch", async () => {
    const insertMock = mock(async () => {});
    const replaceMock = mock(async () => {});
    const db: RagDatabase = {
      ...mockDb,
      insertChunks: insertMock,
      replaceSource: replaceMock,
    };
    const droppingEmbedder = {
      embedQuery: mock(async () => [0.1, 0.2]),
      embedDocuments: mock(async () => [[0.1, 0.2]]),
    };
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db,
      embedder: droppingEmbedder,
    });
    const chunks = [
      { index: 0, content: "one", metadata: {} },
      { index: 1, content: "two", metadata: {} },
    ];

    // The embedding-count guard throws before any DB write — neither write path runs.
    await expect(indexer.index("product", "p-1", chunks, "en")).rejects.toThrow();
    expect(insertMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("prefers per-chunk metadata.language over the index() default", async () => {
    capturedInsertChunks = [];
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db: mockDb,
      embedder: mockEmbedder,
    });
    const chunks = [
      { index: 0, content: "hindi chunk", metadata: { language: "hi" } },
      { index: 1, content: "default chunk", metadata: {} },
    ];

    await indexer.index("product", "p-1", chunks, "en");

    const rows = capturedInsertChunks as Array<Record<string, unknown>>;
    expect(rows[0].language).toBe("hi");
    expect(rows[1].language).toBe("en");
  });

  it("computes content_normalized via the injected normalizer", async () => {
    capturedInsertChunks = [];
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db: mockDb,
      embedder: mockEmbedder,
      normalizer: { normalize: (t: string) => `N:${t}` },
    });
    await indexer.index("faq", "f-1", [{ index: 0, content: "raw", metadata: {} }], "ar");
    const rows = capturedInsertChunks as Array<Record<string, unknown>>;
    expect(rows[0].content).toBe("raw"); // raw preserved
    expect(rows[0].contentNormalized).toBe("N:raw"); // normalized stored separately
  });

  it("defaults content_normalized to raw content when no normalizer is injected", async () => {
    capturedInsertChunks = [];
    const indexer = new RagIndexer({ tenantId: "t-1", db: mockDb, embedder: mockEmbedder });
    await indexer.index("faq", "f-1", [{ index: 0, content: "raw", metadata: {} }], "en");
    const rows = capturedInsertChunks as Array<Record<string, unknown>>;
    expect(rows[0].contentNormalized).toBe("raw");
  });

  it("awaits an async normalizer (external-service shape)", async () => {
    capturedInsertChunks = [];
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db: mockDb,
      embedder: mockEmbedder,
      normalizer: { normalize: async (t: string) => `A:${t}` },
    });
    await indexer.index("faq", "f-1", [{ index: 0, content: "raw", metadata: {} }], "ar");
    const rows = capturedInsertChunks as Array<Record<string, unknown>>;
    expect(rows[0].contentNormalized).toBe("A:raw");
  });

  it("segments content_normalized via the injected segmenter (raw content preserved)", async () => {
    capturedInsertChunks = [];
    const seg = {
      segmentsLanguage: (l: string) => l === "th",
      segment: (t: string, l: string) => (l === "th" ? `${t}|SEG` : t),
    };
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db: mockDb,
      embedder: mockEmbedder,
      segmenter: seg,
    });
    await indexer.index(
      "faq",
      "f-1",
      [{ index: 0, content: "ราคา", metadata: { language: "th" } }],
      "th",
    );
    const rows = capturedInsertChunks as Array<Record<string, unknown>>;
    expect(rows[0].content).toBe("ราคา"); // raw kept for embedding + display
    expect(rows[0].contentNormalized).toBe("ราคา|SEG"); // segmented for the lexical legs
  });

  it("applies normalizer THEN segmenter to content_normalized", async () => {
    capturedInsertChunks = [];
    const seg = { segmentsLanguage: () => true, segment: (t: string) => `${t}>S` };
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db: mockDb,
      embedder: mockEmbedder,
      normalizer: { normalize: (t: string) => `N:${t}` },
      segmenter: seg,
    });
    await indexer.index("faq", "f-1", [{ index: 0, content: "x", metadata: {} }], "th");
    const rows = capturedInsertChunks as Array<Record<string, unknown>>;
    expect(rows[0].contentNormalized).toBe("N:x>S"); // fold first, then segment
  });
});
