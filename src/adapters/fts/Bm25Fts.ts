import type { FtsContext, FtsStrategy, SqlClient } from "../../interfaces.js";
import { buildBm25Query } from "../../synonymExpander.js";
import type { RankedCandidate } from "../../types.js";
import { buildFilters, toRankedCandidate } from "../sqlHelpers.js";
import { bm25IndexName, bm25LanguagePredicate } from "./bm25LanguageGroups.js";

/**
 * BM25 FTS strategy backed by pg_textsearch. Uses a flat term list and the `<@>`
 * BM25 distance operator. `<@>` returns negative BM25 distance (lower = better),
 * so we ORDER BY ascending and negate for a positive score. A language-group
 * predicate steers the planner to the matching partial BM25 index (sql/011).
 *
 * Requires migration 011 + shared_preload_libraries includes 'pg_textsearch'.
 */
export class Bm25Fts implements FtsStrategy {
  async search(client: SqlClient, ctx: FtsContext): Promise<RankedCandidate[]> {
    const bm25Query = buildBm25Query(ctx.query, ctx.synonyms);
    if (!bm25Query) return [];

    // base params: $1 tenant, $2 query, $3 limit -> filters start at $4
    const baseParams: unknown[] = [ctx.tenantId, bm25Query, ctx.candidateLimit];
    const f = buildFilters(ctx, 4);
    const langPredicate = bm25LanguagePredicate(ctx.language);
    // pg_textsearch requires the index name to be passed explicitly to to_bm25query().
    // The index name comes from a trusted constant (never user input), so embedding it
    // as a SQL literal is safe.
    const idxName = bm25IndexName(ctx.language);

    const sql = `
          SELECT id, content, source_type, source_id, metadata,
                 -(content <@> to_bm25query($2, '${idxName}')) as score
          FROM rag_documents
          WHERE tenant_id = $1
            AND ${langPredicate}
            ${f.clause}
          ORDER BY content <@> to_bm25query($2, '${idxName}')
          LIMIT $3
        `;
    const rows = await client.query<Record<string, unknown>>(sql, [...baseParams, ...f.params]);
    return rows.map(toRankedCandidate);
  }
}
