import type { ValidatedFilter } from "./metadata/filterSchema.js";

/** Fusion method for combining the search legs. */
export type FusionMethod = "rrf" | "linear";

/** Per-leg score normalization for linear fusion. */
export type FusionNormalizer = "minmax" | "l2";

/** Result from a RAG search query. */
export interface RagResult {
  content: string;
  sourceType: string;
  sourceId: string | null;
  score: number;
  metadata: Record<string, string>;
  /** Typed attributes stored with the article; `[]` when there are none. */
  attributes: AttributeOutput[];
}

/** Options for RAG search. */
export interface RagSearchOptions {
  topK?: number;
  /**
   * Minimum cosine similarity for the vector leg; chunks below it are dropped before RRF.
   * Embedder-specific: the `0.8` default is calibrated for e5-family models. Better-calibrated
   * embedders (e.g. bge-m3) place true-positive cosines lower, so `0.8` can silently drop the
   * dense leg — lower it (e.g. `0`–`0.5`) when you change embedders. About the embedder's score
   * distribution, not language.
   */
  vectorMinScore?: number;
  keywordMinScore?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  ftsWeight?: number;
  rrfK?: number;
  /**
   * How the search legs are fused. "rrf" (default) = Reciprocal Rank Fusion (rank-only).
   * "linear" = per-leg score normalization + weighted sum (uses the legs' actual relevance
   * magnitudes). Reuses vectorWeight/keywordWeight/ftsWeight as the linear weights.
   */
  fusion?: FusionMethod;
  /**
   * Per-leg score normalization for linear fusion: "minmax" (default) or "l2". Ignored when
   * fusion is "rrf".
   */
  fusionNormalizer?: FusionNormalizer;
  candidateMultiplier?: number;
  sourceTypes?: string[];
  /** Filter results to specific source IDs. */
  sourceIds?: string[];
  /**
   * Filter results to specific languages (e.g. ['en', 'hi']). Omit for cross-language search.
   * If exactly one language is given and `language` is unset, it is also used as the query
   * language for FTS stemming.
   */
  languages?: string[];
  /**
   * Filter results by typed article attributes. Validated before any embedding/DB work; an invalid
   * filter throws `FilterValidationError`, and a database that cannot apply it in every search leg
   * throws `AttributeFiltersUnsupportedError` (fail closed).
   */
  filter?: FilterExpression;
  /**
   * Let the configured `filterModel` derive a metadata filter from the query (validated against
   * the tenant catalog and ANDed with `filter`). Requires `filterModel` and `metadataCatalog`
   * on the pipeline. Default false.
   */
  autoFilter?: boolean;
  /**
   * When an applied generated filter leaves all three legs empty, search once more with only the
   * explicit filter. Default true.
   */
  autoFilterRetryOnEmpty?: boolean;
  /** Drop results scoring below this fraction of the top result (0–1). */
  minRelevance?: number;
  /**
   * Language code for FTS stemming and keyword search (e.g. 'en', 'en-US', 'fr-FR').
   * Required: set this, or pass a single-entry `languages` filter (which is then used as the
   * query language). `search()` throws if neither is provided — there is no default, so a
   * non-English corpus is never silently stemmed/scoped as English.
   */
  language?: string;
  /** Optional normalizer for abbreviation expansion before search. */
  normalizer?: { normalize(text: string, language: string): string };
  /** Enable cross-encoder reranking (default: false). Requires a RerankerProvider. */
  rerank?: boolean;
  /**
   * How many fused candidates to feed the cross-encoder when reranking ("rerank depth").
   * Default: `topK` — i.e. rerank only the RRF top-K. Set higher (e.g. 30) to rerank a
   * BOUNDED UNION of the legs: the reranker scores up to `max(topK, rerankCandidates)` fused
   * candidates and still returns `topK`. This lets a true positive the lexical legs surfaced
   * (but RRF ranked below topK) be recovered by the reranker, instead of being cut pre-rerank.
   * Bounded by what the legs actually return (see `candidateMultiplier`). Only applies when
   * reranking is active.
   */
  rerankCandidates?: number;
  /**
   * Relative reranker cutoff: drop results scoring below this fraction of the top reranked
   * score (default: 0.01). Model-agnostic — keys off the gap between relevant and unrelated
   * results rather than an absolute scale, so it works across rerankers. Set to 0 to disable.
   * Only applies when reranking is active; skipped when the top score is not positive.
   */
  rerankerMinRelativeScore?: number;
  /**
   * Absolute reranker score floor in the model's own score units: drop results scoring below
   * this value (default: 0 = off). Reranker score scales are model-specific (e.g. TEI's
   * bge-reranker-v2-m3 sigmoid output scores even a perfect match around 0.07), so calibrate
   * this to your reranker before enabling. Only applies when reranking is active.
   */
  rerankerMinAbsoluteScore?: number;
}

/** A text chunk produced by the Chunker. */
export interface Chunk {
  content: string;
  index: number;
  metadata: Record<string, string>;
}

/** Per-language lookup: language -> term -> expansion terms (max 5 each). */
export type SynonymLookup = Map<string, Map<string, string[]>>;

/** Internal candidate type used during RRF fusion. */
export interface RankedCandidate {
  /** Stable chunk id (rag_documents.id). Used as the RRF dedup key. */
  id: string;
  content: string;
  sourceType: string;
  sourceId: string | null;
  metadata: string;
  /** Raw attribute JSON text (`attributes::text`); absent on candidates built without it. */
  attributes?: string;
  /**
   * Per-leg relevance score from the producing SQL (vector cosine, trgm word_similarity,
   * bigm coverage, ts_rank_cd, or bm25). Optional: RRF ignores it (rank-only), linear fusion
   * consumes it. Absent when a candidate is constructed without a score column.
   */
  score?: number;
}

/** Parameters for hybrid search (passed to RagDatabase). */
export interface HybridSearchParams {
  tenantId: string;
  embeddingStr: string;
  query: string;
  synonymLookup: SynonymLookup;
  language: string;
  candidateLimit: number;
  vectorMinScore: number;
  keywordMinScore: number;
  sourceTypes?: string[];
  sourceIds?: string[];
  languages?: string[];
  /** Already-validated attribute filter; applied inside every search leg. */
  attributeFilter?: ValidatedFilter;
}

/** Row from stop_words table. */
export interface StopWordRow {
  language: string;
  word: string;
}

/** Row from synonyms table. */
export interface SynonymRow {
  language: string;
  term: string;
  /** JSONB column — a parsed `string[]` or a raw JSON string, depending on the driver. */
  synonyms: string[] | string;
  direction: "two_way" | "one_way";
}

/** Value type of a typed metadata attribute. */
export type AttributeType = "string" | "number" | "boolean" | "date" | "datetime";

/** Format refinement of an attribute type (string: text/email/url/phone/enum; number: float/decimal). */
export type AttributeFormat = "text" | "email" | "url" | "phone" | "enum" | "float" | "decimal";

/** A typed, namespaced attribute as supplied by callers at index time. */
export interface AttributeInput {
  ns?: string;
  key: string;
  type: AttributeType;
  format?: AttributeFormat;
  multi?: boolean;
  value: string | number | boolean | string[];
}

/** A typed attribute as returned to callers. */
export interface AttributeOutput {
  ns: string;
  key: string;
  type: AttributeType;
  format?: AttributeFormat;
  value: string | number | boolean | string[];
}

/** One stored scalar (internal storage encoding, spec §6.4). */
export interface StoredAttributeEntry {
  ns: string;
  k: string;
  t: AttributeType;
  f?: AttributeFormat;
  /** decimal: the exact numeric literal (serialized raw). */
  v: string | number | boolean;
  /** Folded copy, strings only. */
  l?: string;
  /** decimal: original decimal string, for exact output. */
  s?: string;
  /** Entry came from a list value. */
  m?: true;
}

/** Limits applied when normalizing attributes. */
export interface AttributeLimits {
  maxAttributes: number;
  maxValuesPerAttribute: number;
  maxStringLength: number;
}

/** Operators usable in a metadata filter condition. */
export type FilterOp =
  | "equals"
  | "startsWith"
  | "endsWith"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "exists";

/** A scalar operand in a filter condition. */
export type FilterScalar = string | number | boolean;

/** A leaf filter condition on a typed attribute. */
export interface FilterCondition {
  /** Omitted/null = any namespace (global included). */
  ns?: string | string[] | null;
  key: string;
  op: FilterOp;
  value: FilterScalar | FilterScalar[];
  type?: AttributeType | null;
  caseSensitive?: boolean | null;
}

/** A filter expression tree. */
export type FilterExpression =
  | FilterCondition
  | { and: FilterExpression[] }
  | { or: FilterExpression[] }
  | { not: FilterExpression };

/** Limits applied when validating filters. */
export interface FilterLimits {
  maxDepth: number;
  maxConditions: number;
  maxListSize: number;
  maxStringLength: number;
}

/** A metadata key an integrator registers (description + optional declared shape). */
export interface RegisteredKeyInput {
  /** Defaults to "global". */
  ns?: string;
  key: string;
  description: string;
  type?: AttributeType;
  format?: AttributeFormat;
  multi?: boolean;
  allowedValues?: string[];
}

/** One key in a tenant catalog: registry info merged with what is observed in indexed data. */
export interface CatalogKey {
  ns: string;
  key: string;
  registered: boolean;
  description?: string;
  declaredType?: AttributeType;
  declaredFormat?: AttributeFormat;
  multi?: boolean;
  allowedValues?: string[];
  /** One row per observed (type, format); counts are distinct articles, not chunks. */
  observed: Array<{ type: AttributeType; format?: AttributeFormat; articleCount: number }>;
  /** Most common string values by article count. */
  topValues?: Array<{ value: string; articleCount: number }>;
}

/** Tenant-level description of the metadata keys available for filtering. */
export interface MetadataCatalog {
  tenantId: string;
  generatedAt: string;
  keys: CatalogKey[];
}

/** Diagnostics describing how the (explicit + model-generated) metadata filter was handled. */
export interface SearchDiagnostics {
  explicitFilter: FilterExpression | null;
  /** Raw model output (unvalidated). */
  generatedFilter: unknown | null;
  generatedFilterStatus: "not_requested" | "none" | "applied" | "invalid" | "error";
  generatedFilterErrors?: string[];
  retriedWithoutGeneratedFilter: boolean;
}
