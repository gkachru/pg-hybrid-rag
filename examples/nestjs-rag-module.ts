/**
 * Example: NestJS RAG module wiring with Prisma + Pino logger.
 *
 * One-database-per-tenant model: tenant_id is always "default".
 * Prisma handles connection routing; no RLS needed.
 */

import {
  CachingStopWordsLoader,
  CachingSynonymLoader,
  OpenAiCompatibleEmbedder,
  PostgresRagDatabase,
  RagIndexer,
  type RagLogger,
  RagPipeline,
  ragMigrate,
  type SqlClient,
  type TransactionProvider,
} from "pg-hybrid-rag";

// --- Prisma adapter ---

function createPrismaTxProvider(prisma: {
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown>;
}): TransactionProvider {
  return {
    withConnection: async <T>(fn: (client: SqlClient) => Promise<T>): Promise<T> => {
      return fn({
        query: async <R = Record<string, unknown>>(
          sql: string,
          params: unknown[],
        ): Promise<R[]> => {
          const result = await prisma.$queryRawUnsafe(sql, ...params);
          return result as R[];
        },
      });
    },
  };
}

// --- Pino adapter ---

function createPinoLogger(pino: {
  debug: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}): RagLogger {
  return pino;
}

// --- Migration (run once at startup) ---

async function runMigrations(prisma: {
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown>;
}) {
  const client: SqlClient = {
    query: async <R = Record<string, unknown>>(sql: string, params: unknown[]): Promise<R[]> => {
      const result = await prisma.$queryRawUnsafe(sql, ...params);
      return result as R[];
    },
  };

  await ragMigrate(client);
  // For CJK language support (Chinese, Japanese, Korean):
  // await ragMigrate(client, { cjk: true });
}

// --- Module factory ---

export function createRagModule(deps: {
  prisma: { $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown> };
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  logger: {
    debug: (obj: Record<string, unknown>, msg: string) => void;
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
}) {
  const txProvider = createPrismaTxProvider(deps.prisma);
  const embedder = new OpenAiCompatibleEmbedder({
    baseUrl: deps.embeddingBaseUrl,
    apiKey: deps.embeddingApiKey,
    model: deps.embeddingModel,
  });
  const db = new PostgresRagDatabase(txProvider);
  // For CJK keyword search: new PostgresRagDatabase(txProvider, { cjk: true });
  const stopWords = new CachingStopWordsLoader({ txProvider });
  const synonyms = new CachingSynonymLoader({ txProvider });
  const logger = createPinoLogger(deps.logger);

  // tenant_id is always "default" in one-DB-per-tenant model
  const TENANT_ID = "default";

  const pipeline = new RagPipeline({
    tenantId: TENANT_ID,
    db,
    embedder,
    stopWords,
    synonyms,
    logger,
  });

  const indexer = new RagIndexer({
    tenantId: TENANT_ID,
    db,
    embedder,
    logger,
  });

  return { pipeline, indexer, stopWords, synonyms, runMigrations };
}

// --- Usage ---
//
// const rag = createRagModule({ prisma, embeddingBaseUrl, embeddingApiKey, embeddingModel, logger });
//
// // Search with language (determines Postgres FTS stemming config)
// const results = await rag.pipeline.search("blue cotton shirt", { language: "en" });
//
// // Search in other languages — Postgres handles stemming natively
// const resultsFr = await rag.pipeline.search("chemise en coton bleu", { language: "fr" });
//
// // Index with language
// const chunks = new Chunker(512, 75).chunk(productText, { name: "Product Name" });
// await rag.indexer.index("product", productId, chunks, "en");
