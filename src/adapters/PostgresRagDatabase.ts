import type { FtsStrategy, RagDatabase, TransactionProvider } from "../interfaces.js";
import type { HybridSearchParams, RankedCandidate } from "../types.js";
import { TsvectorFts } from "./fts/TsvectorFts.js";
import { buildFilters, toRankedCandidate } from "./sqlHelpers.js";

const CJK_LANGUAGES = new Set(["zh", "zh-CN", "ja", "ja-JP", "ko", "ko-KR"]);

export interface PostgresRagDatabaseOptions {
  /** Enable pg_bigm for CJK keyword search. Requires the pg_bigm extension. Default: false. */
  cjk?: boolean;
  /** FTS strategy for the FTS leg. Default: new TsvectorFts(). Use new Bm25Fts() with migration 011. */
  fts?: FtsStrategy;
}

/**
 * PostgreSQL implementation of RagDatabase.
 * Uses parameterized SQL for all queries — always includes WHERE tenant_id = ?.
 * Requires pgvector and pg_trgm. Optionally uses pg_bigm for CJK keyword search.
 *
 * The vector leg uses the `<=>` cosine operator (IVFFlat or, with migration 010,
 * VectorChord vchordrq — identical SQL). The FTS leg is delegated to a pluggable
 * FtsStrategy (TsvectorFts default; Bm25Fts for pg_textsearch BM25).
 */
export class PostgresRagDatabase implements RagDatabase {
  private txProvider: TransactionProvider;
  private cjk: boolean;
  private fts: FtsStrategy;

  constructor(txProvider: TransactionProvider, options?: PostgresRagDatabaseOptions) {
    this.txProvider = txProvider;
    this.cjk = options?.cjk ?? false;
    this.fts = options?.fts ?? new TsvectorFts();
  }

  async hybridSearch(params: HybridSearchParams): Promise<{
    vectorRows: RankedCandidate[];
    keywordRows: RankedCandidate[];
    ftsRows: RankedCandidate[];
  }> {
    const useBigm = this.cjk && CJK_LANGUAGES.has(params.language);

    // Run all 3 legs in parallel with separate connections for true concurrency
    const [vectorRows, keywordRows, ftsRows] = await Promise.all([
      // --- Vector leg (IVFFlat or vchordrq — identical SQL) ---
      this.txProvider.withConnection(async (client) => {
        const baseParams: unknown[] = [
          params.tenantId,
          params.embeddingStr,
          params.vectorMinScore,
          params.candidateLimit,
        ];
        const f = buildFilters(params, 5);
        const sql = `
          SELECT content, source_type, source_id, metadata,
                 1 - (embedding <=> $2::vector) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND 1 - (embedding <=> $2::vector) >= $3
            ${f.clause}
          ORDER BY embedding <=> $2::vector
          LIMIT $4
        `;
        const rows = await client.query<Record<string, unknown>>(sql, [...baseParams, ...f.params]);
        return rows.map(toRankedCandidate);
      }),

      // --- Keyword leg (pg_trgm or pg_bigm) ---
      this.txProvider.withConnection(async (client) => {
        const baseParams: unknown[] = [
          params.tenantId,
          params.query,
          params.keywordMinScore,
          params.candidateLimit,
        ];
        const f = buildFilters(params, 5);
        const similarityFn = useBigm ? "bigm_similarity" : "word_similarity";
        const sql = `
          SELECT content, source_type, source_id, metadata,
                 ${similarityFn}($2, content) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND ${similarityFn}($2, content) > $3
            ${f.clause}
          ORDER BY ${similarityFn}($2, content) DESC
          LIMIT $4
        `;
        const rows = await client.query<Record<string, unknown>>(sql, [...baseParams, ...f.params]);
        return rows.map(toRankedCandidate);
      }),

      // --- FTS leg (pluggable strategy) ---
      this.txProvider.withConnection((client) =>
        this.fts.search(client, {
          tenantId: params.tenantId,
          query: params.query,
          synonyms: params.synonymLookup,
          language: params.language,
          candidateLimit: params.candidateLimit,
          sourceTypes: params.sourceTypes,
          sourceIds: params.sourceIds,
          languages: params.languages,
        }),
      ),
    ]);

    return { vectorRows, keywordRows, ftsRows };
  }

  async insertChunks(
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
  ): Promise<void> {
    if (chunks.length === 0) return;

    return this.txProvider.withConnection(async (client) => {
      const params: unknown[] = [];
      const valueClauses: string[] = [];

      for (const chunk of chunks) {
        const offset = params.length;
        const embeddingStr = `[${chunk.embedding.join(",")}]`;
        params.push(
          tenantId,
          chunk.sourceType,
          chunk.sourceId,
          chunk.chunkIndex,
          chunk.content,
          chunk.language,
          embeddingStr,
          chunk.metadata,
        );
        valueClauses.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::vector, $${offset + 8})`,
        );
      }

      await client.query(
        `INSERT INTO rag_documents (tenant_id, source_type, source_id, chunk_index, content, language, embedding, metadata)
         VALUES ${valueClauses.join(", ")}`,
        params,
      );
    });
  }

  async deleteBySource(tenantId: string, sourceType: string, sourceId: string): Promise<void> {
    return this.txProvider.withConnection(async (client) => {
      await client.query(
        `DELETE FROM rag_documents WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`,
        [tenantId, sourceType, sourceId],
      );
    });
  }
}
