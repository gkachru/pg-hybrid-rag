import type {
  EmbeddingProvider,
  Normalizer,
  RagDatabase,
  RagLogger,
  Segmenter,
} from "./interfaces.js";
import type { Chunk } from "./types.js";

const noopLogger: RagLogger = {
  info: () => {},
  warn: () => {},
};

export interface RagIndexerConfig {
  tenantId: string;
  db: RagDatabase;
  embedder: EmbeddingProvider;
  /** Optional lexical normalizer; applied to content for the `content_normalized` column. */
  normalizer?: Normalizer;
  /** Optional word segmenter; applied AFTER the normalizer to content_normalized (Thai/CJK). */
  segmenter?: Segmenter;
  logger?: RagLogger;
}

export class RagIndexer {
  private tenantId: string;
  private db: RagDatabase;
  private embedder: EmbeddingProvider;
  private normalizer?: Normalizer;
  private segmenter?: Segmenter;
  private logger: RagLogger;

  constructor(config: RagIndexerConfig) {
    this.tenantId = config.tenantId;
    this.db = config.db;
    this.embedder = config.embedder;
    this.normalizer = config.normalizer;
    this.segmenter = config.segmenter;
    this.logger = config.logger ?? noopLogger;
  }

  /**
   * Index chunks into rag_documents.
   * Atomically replaces existing chunks for the same source (DELETE + INSERT in one transaction)
   * so a failed insert can't leave the source with its old chunks deleted and nothing in place.
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

    // Guard against an embedder that drops or duplicates inputs: a count mismatch
    // would otherwise yield undefined embeddings or silently misaligned vectors.
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedder returned ${embeddings.length} embeddings for ${chunks.length} chunks`,
      );
    }

    // Build the chunk rows. content stays raw (display + dense embedding); content_normalized
    // feeds the lexical legs. Identity when no normalizer is injected (non-Arabic unaffected).
    // Prefer each chunk's own language (the Chunker sizes chunks from it) so the
    // tsvector trigger stems correctly and the `languages` filter stays accurate.
    const values = await Promise.all(
      chunks.map(async (chunk, i) => {
        const lang = chunk.metadata.language ?? language;
        const content = chunk.content;
        let contentNormalized = this.normalizer
          ? await this.normalizer.normalize(content, lang)
          : content;
        if (this.segmenter) {
          contentNormalized = await this.segmenter.segment(contentNormalized, lang);
        }
        return {
          sourceType,
          sourceId,
          chunkIndex: String(chunk.index),
          content,
          contentNormalized,
          language: lang,
          embedding: embeddings[i],
          metadata: JSON.stringify(chunk.metadata),
        };
      }),
    );

    // Replace the source's chunks atomically: the DELETE of the old chunks and the INSERT of the
    // new ones happen in one transaction, so a failed INSERT rolls the DELETE back rather than
    // leaving the source empty (silent data loss on a routine re-index).
    await this.db.replaceSource(this.tenantId, sourceType, sourceId, values);

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
