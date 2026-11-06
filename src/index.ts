// Adapters

export type { CachingMetadataCatalogConfig } from "./adapters/CachingMetadataCatalog.js";
export { CachingMetadataCatalog } from "./adapters/CachingMetadataCatalog.js";
export type { CachingStopWordsLoaderConfig } from "./adapters/CachingStopWordsLoader.js";
export { CachingStopWordsLoader } from "./adapters/CachingStopWordsLoader.js";
export type { CachingSynonymLoaderConfig } from "./adapters/CachingSynonymLoader.js";
export { CachingSynonymLoader } from "./adapters/CachingSynonymLoader.js";
export { Bm25Fts } from "./adapters/fts/Bm25Fts.js";
export { TsvectorFts } from "./adapters/fts/TsvectorFts.js";
export type { IntlSegmenterAdapterConfig } from "./adapters/IntlSegmenter.js";
export { IntlSegmenterAdapter } from "./adapters/IntlSegmenter.js";
export type { OpenAiCompatibleEmbedderConfig } from "./adapters/OpenAiCompatibleEmbedder.js";
export {
  EmbeddingApiError,
  EmbeddingResponseError,
  OpenAiCompatibleEmbedder,
} from "./adapters/OpenAiCompatibleEmbedder.js";
export type { OpenAiCompatibleFilterModelConfig } from "./adapters/OpenAiCompatibleFilterModel.js";
export {
  FilterModelApiError,
  FilterModelResponseError,
  OpenAiCompatibleFilterModel,
} from "./adapters/OpenAiCompatibleFilterModel.js";
export type { PostgresRagDatabaseOptions } from "./adapters/PostgresRagDatabase.js";
export { PostgresRagDatabase } from "./adapters/PostgresRagDatabase.js";
export type { BuiltFilters, SearchFilters } from "./adapters/sqlHelpers.js";
export { buildFilters, toRankedCandidate } from "./adapters/sqlHelpers.js";
export { Chunker, type ChunkerConfig } from "./Chunker.js";
// Core
export { AttributeFiltersUnsupportedError } from "./errors.js";
// Interfaces
export type {
  ChunkingProvider,
  EmbeddingProvider,
  FilterModelContext,
  FilterModelProvider,
  FtsContext,
  FtsStrategy,
  MetadataCatalogProvider,
  Normalizer,
  RagDatabase,
  RagLogger,
  RagSpan,
  RagTracer,
  RerankerProvider,
  Segmenter,
  SqlClient,
  StopWordsProvider,
  SynonymProvider,
  TransactionProvider,
} from "./interfaces.js";
export { detectLanguage } from "./language.js";
// Utilities
export { applyLinearFusion } from "./linearFusion.js";
export {
  AttributeValidationError,
  DEFAULT_ATTRIBUTE_LIMITS,
  GLOBAL_NS,
  normalizeAttributes,
  parseAttributes,
  serializeAttributes,
} from "./metadata/attributes.js";
export type {
  FilterValidationOptions,
  ResolvedCondition,
  ValidatedFilter,
} from "./metadata/filterSchema.js";
export {
  assertValidFilter,
  DEFAULT_FILTER_LIMITS,
  FILTER_GENERATION_SCHEMA,
  FILTER_JSON_SCHEMA,
  FilterValidationError,
  validateFilter,
} from "./metadata/filterSchema.js";
export type { MigrateOptions } from "./migrate.js";
export { ragMigrate } from "./migrate.js";
export type { ArabicNormalizeOptions } from "./normalize.js";
export { LanguageNormalizer, normalizeForLanguage } from "./normalize.js";
export { stripTrailingPunctuation, TRAILING_PUNCTUATION } from "./punctuation.js";
export type { RagIndexerConfig } from "./RagIndexer.js";
export { RagIndexer } from "./RagIndexer.js";
export type { RagPipelineConfig } from "./RagPipeline.js";
export { RagPipeline } from "./RagPipeline.js";
export type { LanguageRecommendation } from "./recommend.js";
export { recommendForLanguage } from "./recommend.js";
export { applyRRF } from "./rrf.js";
export { removeStopWords } from "./stopWords.js";
export { buildBm25Query, buildFtsQuery, expandQueryWithSynonyms } from "./synonymExpander.js";
// Types
export type {
  AttributeFormat,
  AttributeInput,
  AttributeLimits,
  AttributeOutput,
  AttributeType,
  CatalogKey,
  Chunk,
  FilterCondition,
  FilterExpression,
  FilterLimits,
  FilterOp,
  FilterScalar,
  FusionMethod,
  FusionNormalizer,
  HybridSearchParams,
  MetadataCatalog,
  RagResult,
  RagSearchOptions,
  RankedCandidate,
  RegisteredKeyInput,
  SearchDiagnostics,
  SearchLeg,
  StopWordRow,
  StoredAttributeEntry,
  SynonymLookup,
  SynonymRow,
} from "./types.js";
