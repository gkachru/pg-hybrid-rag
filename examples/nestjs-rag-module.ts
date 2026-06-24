/**
 * Example: NestJS RAG module wiring with Prisma + Pino logger.
 *
 * One-database-per-tenant model: tenant_id is always "default".
 * Prisma handles connection routing; no RLS needed.
 */

import {
  CachingStopWordsLoader,
  CachingSynonymLoader,
  IntlSegmenterAdapter,
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
  // The bare client above applies migrations per-statement (non-atomic). For atomic
  // migrations (each file wrapped in BEGIN/COMMIT, rolled back on error), pass a
  // TransactionProvider whose withConnection runs on a single connection — e.g. backed by
  // prisma.$transaction((tx) => ...) so every statement uses the same session.
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
  // Optional word segmenter for whitespace-less scripts (Thai/CJK). Inject the SAME instance
  // into db + pipeline + indexer so indexing, querying, and keyword-leg routing stay consistent.
  // IntlSegmenterAdapter is a zero-dependency reference (stdlib Intl.Segmenter) — its Thai quality
  // is weak on loanwords; for production Thai inject a dictionary/ML/HTTP segmenter. It passes
  // through any language not listed, so it is safe alongside an English/multilingual corpus.
  const segmenter = new IntlSegmenterAdapter({ languages: ["th"] });

  const db = new PostgresRagDatabase(txProvider, { segmenter });
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
    segmenter,
  });

  const indexer = new RagIndexer({
    tenantId: TENANT_ID,
    db,
    embedder,
    logger,
    segmenter,
  });

  return { pipeline, indexer, stopWords, synonyms, runMigrations, segmenter };
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
// const chunker = new Chunker({ tokenLimit: 512, overlap: 75 });
// const chunks = chunker.chunk(productText, { name: "Product Name", language: "en" });
// await rag.indexer.index("product", productId, chunks, "en");
//
// // Index a Thai document — chunkSegmented (async) gives word-aware boundaries; emitted chunk
// // text stays natural. Pass the module's segmenter into the Chunker too.
// const chunker = new Chunker({ tokenLimit: 512, overlap: 75, segmenter: rag.segmenter });
// const thChunks = await chunker.chunkSegmented(thaiText, { language: "th" });
// await rag.indexer.index("faq", faqId, thChunks, "th");
