import type { RagDatabase, TransactionProvider } from "../interfaces.js";
import type { HybridSearchParams, RankedCandidate } from "../types.js";

const CJK_LANGUAGES = new Set(["zh", "zh-CN", "ja", "ja-JP", "ko", "ko-KR"]);

export interface PostgresRagDatabaseOptions {
  /** Enable pg_bigm for CJK keyword search. Requires the pg_bigm extension. Default: false. */
  cjk?: boolean;
}

/**
 * PostgreSQL implementation of RagDatabase.
 * Uses parameterized SQL for all queries — always includes WHERE tenant_id = ?.
 * Requires pgvector and pg_trgm. Optionally uses pg_bigm for CJK keyword search.
 *
 * Stemming is handled by Postgres via language-specific FTS configs (rag_fts_config function).
 * The keyword leg uses raw content (not content_stemmed) with pg_trgm or pg_bigm similarity.
 */
export class PostgresRagDatabase implements RagDatabase {
  private txProvider: TransactionProvider;
  private cjk: boolean;

  constructor(txProvider: TransactionProvider, options?: PostgresRagDatabaseOptions) {
    this.txProvider = txProvider;
    this.cjk = options?.cjk ?? false;
  }

  async hybridSearch(params: HybridSearchParams): Promise<{
    vectorRows: RankedCandidate[];
    keywordRows: RankedCandidate[];
    ftsRows: RankedCandidate[];
  }> {
    const sourceTypeClause = params.sourceTypes?.length
      ? `AND source_type = ANY($SOURCE_TYPES)`
      : "";
    const sourceIdClause = params.sourceIds?.length ? `AND source_id = ANY($SOURCE_IDS)` : "";

    const buildParams = (baseParams: unknown[]): unknown[] => {
      const p = [...baseParams];
      if (params.sourceTypes?.length) p.push(params.sourceTypes);
      if (params.sourceIds?.length) p.push(params.sourceIds);
      return p;
    };

    const paramIdx = (baseCount: number): { sourceType: string; sourceId: string } => {
      let idx = baseCount + 1;
      const sourceType = params.sourceTypes?.length ? `$${idx++}` : "";
      const sourceId = params.sourceIds?.length ? `$${idx}` : "";
      return { sourceType, sourceId };
    };

    const toCandidate = (row: Record<string, unknown>): RankedCandidate => ({
      content: row.content as string,
      sourceType: row.source_type as string,
      sourceId: row.source_id as string | null,
      metadata: (row.metadata as string) || "{}",
    });

    const useBigm = this.cjk && CJK_LANGUAGES.has(params.language);

    // Run all 3 legs in parallel with separate connections for true concurrency
    const [vectorRows, keywordRows, ftsRows] = await Promise.all([
      // --- Vector leg ---
      this.txProvider.withConnection(async (client) => {
        const baseParams = [
          params.tenantId,
          params.embeddingStr,
          params.vectorMinScore,
          params.candidateLimit,
        ];
        const idx = paramIdx(4);
        const sql = `
          SELECT content, source_type, source_id, metadata,
                 1 - (embedding <=> $2::vector) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND 1 - (embedding <=> $2::vector) >= $3
            ${sourceTypeClause.replace("$SOURCE_TYPES", idx.sourceType)}
            ${sourceIdClause.replace("$SOURCE_IDS", idx.sourceId)}
          ORDER BY embedding <=> $2::vector
          LIMIT $4
        `;
        const rows = await client.query<Record<string, unknown>>(sql, buildParams(baseParams));
        return rows.map(toCandidate);
      }),

      // --- Keyword leg (pg_trgm or pg_bigm) ---
      this.txProvider.withConnection(async (client) => {
        const baseParams = [
          params.tenantId,
          params.query,
          params.keywordMinScore,
          params.candidateLimit,
        ];
        const idx = paramIdx(4);

        const similarityFn = useBigm ? "bigm_similarity" : "word_similarity";
        const sql = `
          SELECT content, source_type, source_id, metadata,
                 ${similarityFn}($2, content) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND ${similarityFn}($2, content) > $3
            ${sourceTypeClause.replace("$SOURCE_TYPES", idx.sourceType)}
            ${sourceIdClause.replace("$SOURCE_IDS", idx.sourceId)}
          ORDER BY ${similarityFn}($2, content) DESC
          LIMIT $4
        `;
        const rows = await client.query<Record<string, unknown>>(sql, buildParams(baseParams));
        return rows.map(toCandidate);
      }),

      // --- FTS leg (language-aware via rag_fts_config) ---
      this.txProvider.withConnection(async (client) => {
        const useTsquery = params.ftsQueryStr.includes("|") || params.ftsQueryStr.includes("&");

        if (useTsquery) {
          const baseParams = [
            params.tenantId,
            params.ftsQueryStr,
            params.candidateLimit,
            params.language,
          ];
          const idx = paramIdx(4);
          const sql = `
            SELECT content, source_type, source_id, metadata,
                   ts_rank_cd(content_tsvector, to_tsquery(rag_fts_config($4), $2)) as score
            FROM rag_documents
            WHERE tenant_id = $1
              AND content_tsvector @@ to_tsquery(rag_fts_config($4), $2)
              ${sourceTypeClause.replace("$SOURCE_TYPES", idx.sourceType)}
              ${sourceIdClause.replace("$SOURCE_IDS", idx.sourceId)}
            ORDER BY ts_rank_cd(content_tsvector, to_tsquery(rag_fts_config($4), $2)) DESC
            LIMIT $3
          `;
          const rows = await client.query<Record<string, unknown>>(sql, buildParams(baseParams));
          return rows.map(toCandidate);
        }

        const baseParams = [params.tenantId, params.query, params.candidateLimit, params.language];
        const idx = paramIdx(4);
        const sql = `
          SELECT content, source_type, source_id, metadata,
                 ts_rank_cd(content_tsvector, plainto_tsquery(rag_fts_config($4), $2)) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND content_tsvector @@ plainto_tsquery(rag_fts_config($4), $2)
            ${sourceTypeClause.replace("$SOURCE_TYPES", idx.sourceType)}
            ${sourceIdClause.replace("$SOURCE_IDS", idx.sourceId)}
          ORDER BY ts_rank_cd(content_tsvector, plainto_tsquery(rag_fts_config($4), $2)) DESC
          LIMIT $3
        `;
        const rows = await client.query<Record<string, unknown>>(sql, buildParams(baseParams));
        return rows.map(toCandidate);
      }),
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
      // Build a single INSERT with multiple value rows for batch efficiency
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
