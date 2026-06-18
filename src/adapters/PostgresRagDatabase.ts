import type { FtsStrategy, RagDatabase, SqlClient, TransactionProvider } from "../interfaces.js";
import type { HybridSearchParams, RankedCandidate } from "../types.js";
import { TsvectorFts } from "./fts/TsvectorFts.js";
import { buildFilters, toRankedCandidate } from "./sqlHelpers.js";

const CJK_LANGUAGES = new Set(["zh", "zh-CN", "ja", "ja-JP", "ko", "ko-KR"]);

/** Default number of IVFFlat lists to probe per vector search (postgres default is 1). */
const DEFAULT_IVFFLAT_PROBES = 10;

/**
 * Internal candidate-generation floor for the CJK bigram index probe (`content =% $2`).
 * NOT the relevance threshold — relevance is the query-bigram coverage gate (keywordMinScore).
 *
 * `=%` rechecks pg_bigm's SYMMETRIC similarity ≈ (shared bigrams / DISTINCT doc bigrams), so this
 * floor must sit below the smallest similarity a coverage-passing match can have on the LARGEST
 * chunk we index. bge-m3 allows 8192-token chunks (≈ up to ~8k distinct CJK bigrams): a coverage-
 * 0.75 hit on an 8k-distinct-bigram chunk has similarity ≈ 7.5e-4 — which a 1e-3 floor silently
 * DROPPED. It must also stay > 0: at exactly 0, `sim >= 0` holds for every row, so `=%` matches the
 * whole table (no index selectivity). 1e-4 is the verified middle — it keeps coverage-passing
 * matches for chunks up to ~20k distinct bigrams while still excluding non-sharers.
 */
const CJK_BIGM_CANDIDATE_FLOOR = 0.0001;

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
  /**
   * Whether the tuned search legs open their own `BEGIN`/`COMMIT` around the planner-GUC
   * `set_config` calls + SELECT. Default: true. Set false when the consumer's `withConnection`
   * ALREADY runs the callback inside an interactive transaction (e.g. a postgres.js
   * `withTenantSql` that does `SET LOCAL app.current_tenant_id` for RLS): a nested `BEGIN` warns
   * "there is already a transaction in progress" and the inner `COMMIT` would end the consumer's
   * tenant transaction early (discarding its `SET LOCAL`). When false, the
   * `set_config(..., is_local => true)` calls and the SELECT run in the AMBIENT transaction
   * (the GUCs stay transaction-local to it), and rollback on error is the consumer's
   * responsibility — the adapter rethrows without issuing ROLLBACK.
   */
  manageTransaction?: boolean;
}

interface KeywordLegSql {
  sql: string;
  params: unknown[];
  /** Planner GUCs applied transaction-locally before the SELECT (name is a trusted constant). */
  gucs: Array<{ name: string; value: string }>;
}

/**
 * pg_trgm keyword leg: asymmetric word-similarity, index-driven via the `<%` operator.
 * Threshold (keywordMinScore) is applied via the pg_trgm.word_similarity_threshold GUC.
 */
function buildTrigramKeywordSql(params: HybridSearchParams): KeywordLegSql {
  const baseParams: unknown[] = [params.tenantId, params.query, params.candidateLimit];
  const f = buildFilters(params, 4);
  const sql = `
          SELECT id, content, source_type, source_id, metadata,
                 word_similarity($2, content) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND $2 <% content
            ${f.clause}
          ORDER BY word_similarity($2, content) DESC
          LIMIT $3
        `;
  return {
    sql,
    params: [...baseParams, ...f.params],
    gucs: [{ name: "pg_trgm.word_similarity_threshold", value: String(params.keywordMinScore) }],
  };
}

/**
 * pg_bigm keyword leg for CJK: scores by query-bigram COVERAGE
 * (shared bigrams / query bigrams) — length-independent, the pg_bigm analog of pg_trgm
 * word_similarity. The `=%` operator is demoted to a pure gin_bigm_ops index probe (candidate
 * net, gated by the low CJK_BIGM_CANDIDATE_FLOOR); coverage (>= keywordMinScore) is the relevance
 * filter AND the rank order.
 *
 * The `q` CTE drops show_bigm's space-padded BOUNDARY bigrams (`" X"`, `"X "`) from the query set.
 * pg_bigm pads only the whole string, so a boundary bigram can match only at a chunk's first/last
 * character — never an interior occurrence — yet it would otherwise inflate the denominator and
 * sink short queries (a mid-text 2-char hit like 手机 scores 1/3 ≈ 0.33, below threshold). Counting
 * only interior character bigrams fixes that. Two tradeoffs, both softened by RRF + the other legs:
 * a cross-word substring (价格 inside 评价格外) still matches — inherent to any non-segmenting
 * matcher — and a space-separated multi-token query OR-matches its tokens (rare in CJK).
 */
function buildBigmCoverageKeywordSql(params: HybridSearchParams): KeywordLegSql {
  // $1 tenant, $2 query, $3 candidateLimit, $4 coverage threshold (keywordMinScore); filters from $5.
  const baseParams: unknown[] = [
    params.tenantId,
    params.query,
    params.candidateLimit,
    params.keywordMinScore,
  ];
  const f = buildFilters(params, 5);
  const sql = `
          WITH q AS (
            SELECT ARRAY(SELECT b FROM unnest(show_bigm($2)) AS b WHERE b NOT LIKE '% %') AS qb
          )
          SELECT id, content, source_type, source_id, metadata, score FROM (
            SELECT id, content, source_type, source_id, metadata,
                   cardinality(ARRAY(SELECT unnest(q.qb)
                                     INTERSECT
                                     SELECT unnest(show_bigm(content))))::float
                     / NULLIF(cardinality(q.qb), 0) AS score
            FROM rag_documents, q
            WHERE tenant_id = $1
              AND content =% $2
              ${f.clause}
          ) c
          WHERE score >= $4
          ORDER BY score DESC
          LIMIT $3
        `;
  return {
    sql,
    params: [...baseParams, ...f.params],
    gucs: [{ name: "pg_bigm.similarity_limit", value: String(CJK_BIGM_CANDIDATE_FLOOR) }],
  };
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
  private manageTransaction: boolean;

  constructor(txProvider: TransactionProvider, options?: PostgresRagDatabaseOptions) {
    this.txProvider = txProvider;
    this.cjk = options?.cjk ?? false;
    this.fts = options?.fts ?? new TsvectorFts();
    this.ivfflatProbes = options?.ivfflatProbes ?? DEFAULT_IVFFLAT_PROBES;
    this.manageTransaction = options?.manageTransaction ?? true;
  }

  async hybridSearch(params: HybridSearchParams): Promise<{
    vectorRows: RankedCandidate[];
    keywordRows: RankedCandidate[];
    ftsRows: RankedCandidate[];
  }> {
    const useBigm = this.cjk && CJK_LANGUAGES.has(params.language);

    // Run all 3 legs in parallel with separate connections for true concurrency.
    // Fail-fast is intentional: if any leg fails (e.g. pg_bigm not installed, a missing
    // partial index, a dropped connection) the whole search fails rather than returning
    // partial/degraded results. We use allSettled (not Promise.all) so every leg settles
    // before we raise — Promise.all rejects on the first failure and abandons the sibling
    // legs mid-query on their reserved connections, which hangs a consumer's connection cleanup.
    const settled = await Promise.allSettled([
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

      // --- Keyword leg (pg_trgm word-similarity, or pg_bigm query-bigram coverage for CJK) ---
      this.txProvider.withConnection(async (client) => {
        const leg = useBigm ? buildBigmCoverageKeywordSql(params) : buildTrigramKeywordSql(params);
        const rows = await this.runTuned(client, leg.gucs, leg.sql, leg.params);
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

    // Raise after every leg has settled (so none is left in flight). Report each failed leg
    // by name, carrying the original errors in AggregateError.errors for inspection.
    const legNames = ["vector", "keyword", "fts"] as const;
    const failures = settled.flatMap((r, i) =>
      r.status === "rejected" ? [{ name: legNames[i], reason: r.reason }] : [],
    );
    if (failures.length > 0) {
      const detail = failures
        .map((f) => `${f.name}: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`)
        .join("; ");
      throw new AggregateError(
        failures.map((f) => f.reason),
        `hybridSearch: ${failures.length} of ${settled.length} search legs failed (${detail})`,
      );
    }

    const [vectorRows, keywordRows, ftsRows] = settled.map(
      (r) => (r as PromiseFulfilledResult<RankedCandidate[]>).value,
    );
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
   *
   * When `manageTransaction` is false the consumer's withConnection already opened an interactive
   * transaction (e.g. postgres.js withTenantSql's `SET LOCAL app.current_tenant_id`), so we do NOT
   * emit BEGIN/COMMIT (a nested BEGIN warns and the inner COMMIT would end the consumer's tenant
   * transaction early). The set_config(..., is_local => true) stays transaction-local relative to
   * that ambient transaction. On error we rethrow WITHOUT a ROLLBACK — issuing one would abort the
   * consumer's whole interactive transaction (its SET LOCAL + any prior work); rollback is theirs.
   */
  private async runTuned(
    client: SqlClient,
    gucs: Array<{ name: string; value: string }>,
    sql: string,
    params: unknown[],
  ): Promise<Record<string, unknown>[]> {
    if (!this.manageTransaction) {
      // Ambient-transaction mode: apply the GUCs (still is_local=true, scoped to the consumer's
      // transaction) and run the SELECT directly, with no transaction control of our own.
      for (const guc of gucs) {
        await client.query(`SELECT set_config('${guc.name}', $1, true)`, [guc.value]);
      }
      return client.query<Record<string, unknown>>(sql, params);
    }

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

  /**
   * Build the batch INSERT statement + flattened params for one chunk array. Shared by
   * insertChunks and replaceSource so the placeholder/offset math and the $N::vector cast live
   * in exactly one place. Callers must guard `chunks.length > 0` (an empty array would emit
   * `VALUES ` with no rows). The embedding is serialized to a pgvector literal (`[a,b,c]`).
   */
  private buildInsert(
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
  ): { sql: string; params: unknown[] } {
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

    return {
      sql: `INSERT INTO rag_documents (tenant_id, source_type, source_id, chunk_index, content, language, embedding, metadata)
         VALUES ${valueClauses.join(", ")}`,
      params,
    };
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
      const { sql, params } = this.buildInsert(tenantId, chunks);
      await client.query(sql, params);
    });
  }

  /**
   * Atomically replace a source's chunks: DELETE the source's existing rows then INSERT the new
   * ones in one transaction, pinned to one connection. Re-indexing routes through this so a failed
   * INSERT rolls the DELETE back rather than leaving the source with zero chunks — the old data
   * gone and the new data never landed.
   *
   * Honors `manageTransaction` exactly like runTuned. By default we own the BEGIN/COMMIT (ROLLBACK
   * on error). When it is false the consumer's withConnection already opened an interactive
   * transaction (e.g. postgres.js withTenantSql's `SET LOCAL app.current_tenant_id` for RLS): we
   * run DELETE+INSERT inside that ambient transaction and rethrow on error WITHOUT our own
   * BEGIN/COMMIT/ROLLBACK. Atomicity still holds — a thrown INSERT propagates and the consumer's
   * transaction rolls the DELETE back; issuing our own COMMIT would end their transaction (and
   * discard SET LOCAL) mid-index, and our own ROLLBACK would abort their whole transaction.
   */
  async replaceSource(
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
  ): Promise<void> {
    return this.txProvider.withConnection(async (client) => {
      const runReplace = async () => {
        await client.query(
          `DELETE FROM rag_documents WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`,
          [tenantId, sourceType, sourceId],
        );
        // Guard against a delete-only call (empty chunks would emit `VALUES ` with no rows). In
        // practice RagIndexer.index returns early on empty chunks, so this is always >= 1 there.
        if (chunks.length > 0) {
          const { sql, params } = this.buildInsert(tenantId, chunks);
          await client.query(sql, params);
        }
      };

      // Ambient-transaction mode: run inside the consumer's open transaction, no control of our own.
      if (!this.manageTransaction) {
        return runReplace();
      }

      await client.query("BEGIN", []);
      try {
        await runReplace();
        await client.query("COMMIT", []);
      } catch (err) {
        try {
          await client.query("ROLLBACK", []);
        } catch {
          // ignore rollback failure; surface the original error
        }
        throw err;
      }
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
