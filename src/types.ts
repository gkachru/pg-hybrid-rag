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
   * Defaults to a single-entry `languages` filter when present, otherwise 'en'.
   */
  language?: string;
  /** Optional normalizer for abbreviation expansion before search. */
  normalizer?: { normalize(text: string, language: string): string };
  /** Enable cross-encoder reranking (default: false). Requires a RerankerProvider. */
  rerank?: boolean;
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
  synonyms: string[];
  direction: string;
}
