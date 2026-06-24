/**
 * Example: BullMQ reindex worker using pg-hybrid-rag.
 *
 * Listens for "rag-reindex" jobs and re-indexes products/FAQs.
 * Assumes one-database-per-tenant (tenant_id = "default").
 *
 * The language field on each job determines which Postgres FTS stemming
 * config is used (e.g. "en" → english, "fr" → french, "hi" → simple).
 */

import {
  Chunker,
  IntlSegmenterAdapter,
  OpenAiCompatibleEmbedder,
  PostgresRagDatabase,
  RagIndexer,
  type RagLogger,
  type SqlClient,
  type TransactionProvider,
} from "pg-hybrid-rag";

// --- Types ---

interface ReindexJob {
  sourceType: "product" | "faq";
  sourceId: string;
  content: string;
  /** Language code (e.g. "en", "fr-FR", "zh-CN"). Determines Postgres FTS config. */
  language: string;
  metadata: Record<string, string>;
}

// --- Wiring (same pattern as nestjs-rag-module.ts) ---

function createWorker(deps: {
  prisma: { $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown> };
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  logger: RagLogger;
}) {
  const txProvider: TransactionProvider = {
    withConnection: async <T>(fn: (client: SqlClient) => Promise<T>): Promise<T> => {
      return fn({
        query: async <R = Record<string, unknown>>(
          sql: string,
          params: unknown[],
        ): Promise<R[]> => {
          const result = await deps.prisma.$queryRawUnsafe(sql, ...params);
          return result as R[];
        },
      });
    },
  };

  const embedder = new OpenAiCompatibleEmbedder({
    baseUrl: deps.embeddingBaseUrl,
    apiKey: deps.embeddingApiKey,
    model: deps.embeddingModel,
  });

  // One segmenter, injected into db + chunker + indexer (Thai/CJK have no word spaces).
  // IntlSegmenterAdapter is a zero-dependency reference; for production Thai inject a
  // dictionary/ML/HTTP segmenter. It passes through any language not listed.
  const segmenter = new IntlSegmenterAdapter({ languages: ["th"] });
  const db = new PostgresRagDatabase(txProvider, { segmenter });
  const chunker = new Chunker({ tokenLimit: 512, overlap: 75, segmenter });
  const indexer = new RagIndexer({
    tenantId: "default",
    db,
    embedder,
    segmenter,
    logger: deps.logger,
  });

  return async (job: ReindexJob): Promise<number> => {
    // chunkSegmented = word-aware boundaries for whitespace-less scripts (Thai/CJK);
    // for spaced languages it transparently falls back to chunk().
    const chunks = await chunker.chunkSegmented(job.content, {
      ...job.metadata,
      language: job.language,
    });
    return indexer.index(job.sourceType, job.sourceId, chunks, job.language);
  };
}

export { createWorker, type ReindexJob };
