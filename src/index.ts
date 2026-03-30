// Adapters
export type { CachingStopWordsLoaderConfig } from "./adapters/CachingStopWordsLoader.js";
export { CachingStopWordsLoader } from "./adapters/CachingStopWordsLoader.js";
export type { CachingSynonymLoaderConfig } from "./adapters/CachingSynonymLoader.js";
export { CachingSynonymLoader } from "./adapters/CachingSynonymLoader.js";
export type { OpenAiCompatibleEmbedderConfig } from "./adapters/OpenAiCompatibleEmbedder.js";
export { OpenAiCompatibleEmbedder } from "./adapters/OpenAiCompatibleEmbedder.js";
export type { PostgresRagDatabaseOptions } from "./adapters/PostgresRagDatabase.js";
export { PostgresRagDatabase } from "./adapters/PostgresRagDatabase.js";

// Core
export { Chunker, type ChunkerConfig } from "./Chunker.js";
// Interfaces
export type {
  ChunkingProvider,
  EmbeddingProvider,
  RagDatabase,
  RagLogger,
  RagSpan,
  RagTracer,
  RerankerProvider,
  SqlClient,
  StopWordsProvider,
  SynonymProvider,
  TransactionProvider,
} from "./interfaces.js";
export { detectLanguage } from "./language.js";
export type { MigrateOptions } from "./migrate.js";
export { ragMigrate } from "./migrate.js";
export { stripTrailingPunctuation, TRAILING_PUNCTUATION } from "./punctuation.js";
export type { RagIndexerConfig } from "./RagIndexer.js";
export { RagIndexer } from "./RagIndexer.js";
export type { RagPipelineConfig } from "./RagPipeline.js";
export { RagPipeline } from "./RagPipeline.js";
// Utilities
export { applyRRF } from "./rrf.js";
export { removeStopWords } from "./stopWords.js";
export { buildFtsQuery, expandQueryWithSynonyms } from "./synonymExpander.js";

// Types
export type {
  Chunk,
  HybridSearchParams,
  RagResult,
  RagSearchOptions,
  RankedCandidate,
  StopWordRow,
  SynonymLookup,
  SynonymRow,
} from "./types.js";
