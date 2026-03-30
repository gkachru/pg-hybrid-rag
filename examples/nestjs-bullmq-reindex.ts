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

  const db = new PostgresRagDatabase(txProvider);
  const chunker = new Chunker({ tokenLimit: 512, overlap: 75 });
  const indexer = new RagIndexer({
    tenantId: "default",
    db,
    embedder,
    logger: deps.logger,
  });

  return async (job: ReindexJob): Promise<number> => {
    const chunks = chunker.chunk(job.content, { ...job.metadata, language: job.language });
    return indexer.index(job.sourceType, job.sourceId, chunks, job.language);
  };
}

export { createWorker, type ReindexJob };
