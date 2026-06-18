import type {
  Chunk,
  HybridSearchParams,
  RagResult,
  RankedCandidate,
  SynonymLookup,
} from "./types.js";

/** Chunking provider — consumers can swap in chonkie or any other chunking library. */
export interface ChunkingProvider {
  chunk(text: string, metadata?: Record<string, string>): Chunk[];
}

/** SQL execution — consumer provides their DB connection. */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
}

/** Connection provider — consumer handles routing + RLS if needed. */
export interface TransactionProvider {
  withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}

/** Embedding provider. */
export interface EmbeddingProvider {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

/** Stop words provider (optional — search works without it). */
export interface StopWordsProvider {
  /**
   * Load per-language stop words. The returned map and its sets may be a shared
   * cached reference — treat as read-only; mutating them can corrupt the cache.
   */
  load(tenantId: string): Promise<Map<string, Set<string>>>;
  /**
   * Optional pre-merged set across all languages (avoids per-search merging).
   * May be a shared cached reference — treat as read-only.
   */
  loadMerged?(tenantId: string): Promise<Set<string>>;
  invalidate(tenantId: string): void;
}

/** Synonym provider (optional — FTS works without expansion). */
export interface SynonymProvider {
  /**
   * Load the synonym lookup. The returned map may be a shared cached reference —
   * treat as read-only; mutating it can corrupt the cache.
   */
  load(tenantId: string): Promise<SynonymLookup>;
  invalidate(tenantId: string): void;
}

/** Observability logger (optional — no-ops when not provided). */
export interface RagLogger {
  debug?(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Span handle passed to RagTracer callbacks. */
export interface RagSpan {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}

/** Observability tracer (optional — no-ops when not provided). */
export interface RagTracer {
  startActiveSpan<T>(name: string, fn: (span: RagSpan) => Promise<T>): Promise<T>;
}

/** Cross-encoder reranker (optional — improves relevance post-RRF). */
export interface RerankerProvider {
  rerank(query: string, results: RagResult[], topN: number): Promise<RagResult[]>;
}

/** Database adapter for RAG search operations. */
export interface RagDatabase {
  /** Execute the 3-way hybrid search (vector + keyword + FTS). */
  hybridSearch(params: HybridSearchParams): Promise<{
    vectorRows: RankedCandidate[];
    keywordRows: RankedCandidate[];
    ftsRows: RankedCandidate[];
  }>;

  /** Insert chunks into the rag_documents table. */
  insertChunks(
    tenantId: string,
    chunks: Array<{
      sourceType: string;
      sourceId: string;
      chunkIndex: string;
      content: string;
      language: string;
      embedding: number[];
      metadata: string;
    }>,
  ): Promise<void>;

  /** Delete all chunks for a given source. */
  deleteBySource(tenantId: string, sourceType: string, sourceId: string): Promise<void>;

  /**
   * Atomically replace all chunks for a source: DELETE the source's existing chunks then INSERT
   * the new ones inside ONE transaction (BEGIN/COMMIT, ROLLBACK on error). Used by re-indexing so
   * a failed INSERT can never leave the source with the old data deleted and nothing in its place.
   * `chunks` must all belong to (sourceType, sourceId).
   */
  replaceSource(
    tenantId: string,
    sourceType: string,
    sourceId: string,
    chunks: Array<{
      sourceType: string;
      sourceId: string;
      chunkIndex: string;
      content: string;
      language: string;
      embedding: number[];
      metadata: string;
    }>,
  ): Promise<void>;
}

/** Context passed to an FtsStrategy for one FTS-leg execution. */
export interface FtsContext {
  tenantId: string;
  /** Normalized, stop-words-removed query (the strategy builds its own FTS query form from this). */
  query: string;
  synonyms: SynonymLookup;
  /** Language code for stemming / config selection (e.g. 'en', 'fr-FR'). */
  language: string;
  candidateLimit: number;
  sourceTypes?: string[];
  sourceIds?: string[];
  languages?: string[];
}

/**
 * Pluggable full-text-search leg. Implementations own the FTS query-string form
 * AND the FTS-leg SQL. Injected into PostgresRagDatabase (default: TsvectorFts).
 */
export interface FtsStrategy {
  /** Run the FTS leg against one connection and return ranked candidates (best first). */
  search(client: SqlClient, ctx: FtsContext): Promise<RankedCandidate[]>;
}
