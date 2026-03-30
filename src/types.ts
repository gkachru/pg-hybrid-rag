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
  /** Filter results to specific languages (e.g. ['en', 'hi']). Omit for cross-language search. */
  languages?: string[];
  /** Drop results scoring below this fraction of the top result (0–1). */
  minRelevance?: number;
  /** Language code for FTS stemming and keyword search (e.g. 'en', 'en-US', 'fr-FR'). */
  language?: string;
  /** Optional normalizer for abbreviation expansion before search. */
  normalizer?: { normalize(text: string, language: string): string };
  /** Enable cross-encoder reranking (default: false). Requires a RerankerProvider. */
  rerank?: boolean;
  /** Absolute reranker score floor — results below this are dropped (default: 0.01). Only applies when reranking is active. */
  rerankerMinScore?: number;
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
  ftsQueryStr: string;
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
