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

  it("calls deleteBySource before inserting", async () => {
    const deleteMock = mock(async () => {});
    const db: RagDatabase = {
      ...mockDb,
      deleteBySource: deleteMock,
    };
    const indexer = new RagIndexer({
      tenantId: "t-1",
      db,
      embedder: mockEmbedder,
    });
    const chunks = [{ index: 0, content: "test", metadata: {} }];
    await indexer.index("faq", "faq-1", chunks, "en");
    expect(deleteMock).toHaveBeenCalledWith("t-1", "faq", "faq-1");
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

  it("does not insert when embedding counts mismatch", async () => {
    const insertMock = mock(async () => {});
    const db: RagDatabase = {
      ...mockDb,
      insertChunks: insertMock,
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

    await expect(indexer.index("product", "p-1", chunks, "en")).rejects.toThrow();
    expect(insertMock).not.toHaveBeenCalled();
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
});
