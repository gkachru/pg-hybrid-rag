import type { EmbeddingProvider, RagDatabase, RagLogger } from "./interfaces.js";
import type { Chunk } from "./types.js";

const noopLogger: RagLogger = {
  info: () => {},
  warn: () => {},
};

export interface RagIndexerConfig {
  tenantId: string;
  db: RagDatabase;
  embedder: EmbeddingProvider;
  logger?: RagLogger;
}

export class RagIndexer {
  private tenantId: string;
  private db: RagDatabase;
  private embedder: EmbeddingProvider;
  private logger: RagLogger;

  constructor(config: RagIndexerConfig) {
    this.tenantId = config.tenantId;
    this.db = config.db;
    this.embedder = config.embedder;
    this.logger = config.logger ?? noopLogger;
  }

  /**
   * Index chunks into rag_documents.
   * Deletes existing chunks for the same source before inserting.
   */
  async index(
    sourceType: string,
    sourceId: string,
    chunks: Chunk[],
    language = "en",
  ): Promise<number> {
    if (chunks.length === 0) return 0;

    // Embed all chunks
    const texts = chunks.map((c) => c.content);
    const embeddings = await this.embedder.embedDocuments(texts);

    // Delete existing chunks for this source
    await this.db.deleteBySource(this.tenantId, sourceType, sourceId);

    // Insert all chunks (Postgres handles stemming via tsvector trigger)
    const values = chunks.map((chunk, i) => ({
      sourceType,
      sourceId,
      chunkIndex: String(chunk.index),
      content: chunk.content,
      language,
      embedding: embeddings[i],
      metadata: JSON.stringify(chunk.metadata),
    }));

    await this.db.insertChunks(this.tenantId, values);

    this.logger.info(
      { tenantId: this.tenantId, sourceType, sourceId, chunks: chunks.length },
      "Documents indexed",
    );

    return chunks.length;
  }

  /**
   * Delete all indexed documents for a source.
   */
  async deleteSource(sourceType: string, sourceId: string): Promise<void> {
    await this.db.deleteBySource(this.tenantId, sourceType, sourceId);
  }
}
