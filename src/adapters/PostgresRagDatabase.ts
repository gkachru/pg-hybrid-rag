import type { FtsStrategy, RagDatabase, SqlClient, TransactionProvider } from "../interfaces.js";
import type { HybridSearchParams, RankedCandidate } from "../types.js";
import { TsvectorFts } from "./fts/TsvectorFts.js";
import { buildFilters, toRankedCandidate } from "./sqlHelpers.js";

const CJK_LANGUAGES = new Set(["zh", "zh-CN", "ja", "ja-JP", "ko", "ko-KR"]);

/** Default number of IVFFlat lists to probe per vector search (postgres default is 1). */
const DEFAULT_IVFFLAT_PROBES = 10;

export interface PostgresRagDatabaseOptions {
  /** Enable pg_bigm for CJK keyword search. Requires the pg_bigm extension. Default: false. */
  cjk?: boolean;
  /** FTS strategy for the FTS leg. Default: new TsvectorFts(). Use new Bm25Fts() with migration 011. */
  fts?: FtsStrategy;
  /**
   * IVFFlat lists probed per vector search via `SET LOCAL ivfflat.probes`. Postgres defaults to 1
   * (scanning 1 of `lists` cells → poor recall); higher trades latency for recall. Default: 10.
   * Ignored when the migration-010 vchordrq index is in use. Must be a positive integer.
   */
  ivfflatProbes?: number;
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
  private ivfflatProbes: number;

  constructor(txProvider: TransactionProvider, options?: PostgresRagDatabaseOptions) {
    this.txProvider = txProvider;
    this.cjk = options?.cjk ?? false;
    this.fts = options?.fts ?? new TsvectorFts();
    this.ivfflatProbes = options?.ivfflatProbes ?? DEFAULT_IVFFLAT_PROBES;
  }

  async hybridSearch(params: HybridSearchParams): Promise<{
    vectorRows: RankedCandidate[];
    keywordRows: RankedCandidate[];
    ftsRows: RankedCandidate[];
  }> {
    const useBigm = this.cjk && CJK_LANGUAGES.has(params.language);

    // Run all 3 legs in parallel with separate connections for true concurrency.
    // Promise.all is intentional fail-fast by design: if any single leg rejects (e.g. pg_bigm
    // not installed, a missing partial index, a dropped connection), the whole hybridSearch
    // rejects rather than returning partial results from the surviving legs.
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
          SELECT id, content, source_type, source_id, metadata,
                 1 - (embedding <=> $2::vector) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND 1 - (embedding <=> $2::vector) >= $3
            ${f.clause}
          ORDER BY embedding <=> $2::vector
          LIMIT $4
        `;
        // Probe more than the IVFFlat default of 1 cell for usable recall. SET LOCAL can't take
        // a bind param, so use set_config(..., is_local => true) — same transaction-local scope.
        // No-op for the migration-010 vchordrq index, which ignores ivfflat.probes.
        const rows = await this.runTuned(
          client,
          [{ name: "ivfflat.probes", value: String(this.ivfflatProbes) }],
          sql,
          [...baseParams, ...f.params],
        );
        return rows.map(toRankedCandidate);
      }),

      // --- Keyword leg (pg_trgm or pg_bigm) ---
      this.txProvider.withConnection(async (client) => {
        // The keyword threshold is applied via the per-extension GUC below (set transaction-
        // locally), NOT as a bound parameter — so it is intentionally absent from baseParams.
        // Binding it as an unreferenced $N would make Postgres reject the statement with
        // "could not determine data type of parameter $N".
        const baseParams: unknown[] = [params.tenantId, params.query, params.candidateLimit];
        const f = buildFilters(params, 4);
        // Drive the trigram GIN index via the (in)equality-style operators rather than a bare
        // word_similarity()/bigm_similarity() > threshold comparison, which the planner can't turn
        // into an index condition. The threshold moves into the per-extension GUC (set transaction-
        // locally below); the similarity function stays only in SELECT/ORDER BY for the score.
        //   pg_trgm: `$2 <% content` ≡ word_similarity($2, content) >= pg_trgm.word_similarity_threshold
        //   pg_bigm: `content =% $2` ≡ bigm_similarity(...) >= pg_bigm.similarity_limit
        const similarityFn = useBigm ? "bigm_similarity" : "word_similarity";
        const matchExpr = useBigm ? "content =% $2" : "$2 <% content";
        const thresholdGuc = useBigm
          ? "pg_bigm.similarity_limit"
          : "pg_trgm.word_similarity_threshold";
        const sql = `
          SELECT id, content, source_type, source_id, metadata,
                 ${similarityFn}($2, content) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND ${matchExpr}
            ${f.clause}
          ORDER BY ${similarityFn}($2, content) DESC
          LIMIT $3
        `;
        const rows = await this.runTuned(
          client,
          [{ name: thresholdGuc, value: String(params.keywordMinScore) }],
          sql,
          [...baseParams, ...f.params],
        );
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

  /**
   * Run a SELECT with planner GUCs applied transaction-locally. `SET LOCAL` is a utility
   * statement that cannot take a bind parameter, so values are applied via set_config(name,
   * value, is_local => true), which is parameterized and scoped to the wrapping transaction.
   * The GUC *name* is a trusted constant (never user input — same safety basis as the BM25 index
   * name) so it is inlined as a literal; only the *value* is bound. Wrapping in BEGIN/COMMIT is
   * what makes "LOCAL" meaningful, and only works when the consumer's withConnection pins all
   * queries in the callback to one connection (the documented contract for the search path;
   * pooled providers must reserve a connection per withConnection — see README).
   */
  private async runTuned(
    client: SqlClient,
    gucs: Array<{ name: string; value: string }>,
    sql: string,
    params: unknown[],
  ): Promise<Record<string, unknown>[]> {
    await client.query("BEGIN", []);
    try {
      for (const guc of gucs) {
        await client.query(`SELECT set_config('${guc.name}', $1, true)`, [guc.value]);
      }
      const rows = await client.query<Record<string, unknown>>(sql, params);
      await client.query("COMMIT", []);
      return rows;
    } catch (err) {
      try {
        await client.query("ROLLBACK", []);
      } catch {
        // ignore rollback failure; surface the original error
      }
      throw err;
    }
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
