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
  load(tenantId: string): Promise<Map<string, Set<string>>>;
  /** Optional pre-merged set across all languages (avoids per-search merging). */
  loadMerged?(tenantId: string): Promise<Set<string>>;
  invalidate(tenantId: string): void;
}

/** Synonym provider (optional — FTS works without expansion). */
export interface SynonymProvider {
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
}
