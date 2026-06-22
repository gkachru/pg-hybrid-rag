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
}

/** Options for RAG search. */
export interface RagSearchOptions {
  topK?: number;
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
