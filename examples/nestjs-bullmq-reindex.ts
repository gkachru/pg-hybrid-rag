/**
 * Example: BullMQ reindex worker using pg-hybrid-rag.
 *
 * Listens for "rag-reindex" jobs and re-indexes products/FAQs.
 * Assumes one-database-per-tenant: every row uses one fixed tenant_id (a UUID).
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
  /** UUID of the product/FAQ (rag_documents.source_id is a UUID column). */
  sourceId: string;
  content: string;
  /** Language code (e.g. "en", "fr-FR", "zh-CN"). Determines Postgres FTS config. */
  language: string;
  metadata: Record<string, string>;
}

// --- Wiring (same pattern as nestjs-rag-module.ts) ---

type QueryRaw = (sql: string, ...params: unknown[]) => Promise<unknown>;

function createWorker(deps: {
  prisma: {
    $transaction: <T>(
      fn: (tx: { $queryRawUnsafe: QueryRaw }) => Promise<T>,
      options?: { timeout?: number },
    ) => Promise<T>;
  };
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  logger: RagLogger;
}) {
  // Pin each callback to one connection with an interactive transaction (see
  // nestjs-rag-module.ts). The adapter then runs with manageTransaction: false, so the
  // delete + insert of a re-index commit or roll back together with Prisma's transaction.
  const txProvider: TransactionProvider = {
    withConnection: <T>(fn: (client: SqlClient) => Promise<T>): Promise<T> =>
      deps.prisma.$transaction(
        (tx) =>
          fn({
            query: async <R = Record<string, unknown>>(
              sql: string,
              params: unknown[],
            ): Promise<R[]> => (await tx.$queryRawUnsafe(sql, ...params)) as R[],
          }),
        { timeout: 60_000 }, // embedding happens before this; the DB write itself is short
      ),
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
  const db = new PostgresRagDatabase(txProvider, { segmenter, manageTransaction: false });
  const chunker = new Chunker({ tokenLimit: 512, overlap: 75, segmenter });
  const indexer = new RagIndexer({
    tenantId: "00000000-0000-0000-0000-000000000001", // tenant_id is a UUID column
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
