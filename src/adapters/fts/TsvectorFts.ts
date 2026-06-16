import type { FtsContext, FtsStrategy, SqlClient } from "../../interfaces.js";
import { buildFtsQuery } from "../../synonymExpander.js";
import type { RankedCandidate } from "../../types.js";
import { buildFilters, toRankedCandidate } from "../sqlHelpers.js";

/**
 * Default FTS strategy: Postgres tsvector/tsquery with language-aware stemming
 * via rag_fts_config(). Preserves the original PostgresRagDatabase FTS-leg behavior.
 */
export class TsvectorFts implements FtsStrategy {
  async search(client: SqlClient, ctx: FtsContext): Promise<RankedCandidate[]> {
    const ftsQueryStr = buildFtsQuery(ctx.query, ctx.synonyms);
    const useTsquery = ftsQueryStr.includes("|") || ftsQueryStr.includes("&");

    // base params: $1 tenant, $2 query-string, $3 limit, $4 language -> filters start at $5
    const queryArg = useTsquery ? ftsQueryStr : ctx.query;
    const baseParams: unknown[] = [ctx.tenantId, queryArg, ctx.candidateLimit, ctx.language];
    const f = buildFilters(ctx, 5);
    const tsExpr = useTsquery
      ? "to_tsquery(rag_fts_config($4), $2)"
      : "plainto_tsquery(rag_fts_config($4), $2)";

    const sql = `
          SELECT content, source_type, source_id, metadata,
                 ts_rank_cd(content_tsvector, ${tsExpr}) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND content_tsvector @@ ${tsExpr}
            ${f.clause}
          ORDER BY ts_rank_cd(content_tsvector, ${tsExpr}) DESC
          LIMIT $3
        `;
    const rows = await client.query<Record<string, unknown>>(sql, [...baseParams, ...f.params]);
    return rows.map(toRankedCandidate);
  }
}
