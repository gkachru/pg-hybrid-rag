import type { RankedCandidate } from "../types.js";

/** The optional result filters shared by all search legs. */
export interface SearchFilters {
  sourceTypes?: string[];
  sourceIds?: string[];
  languages?: string[];
}

export interface BuiltFilters {
  /** AND-prefixed clause text with $N placeholders (empty string when no filters are active). */
  clause: string;
  /** Param values to append to the leg's base params, in placeholder order. */
  params: string[];
}

/**
 * Build the shared source-type / source-id / language WHERE clauses.
 * Uses string_to_array(...) for driver-agnostic array binding (matches existing convention).
 *
 * @param filters which optional filters are active
 * @param startIdx the first $N placeholder index to use (i.e. baseParams.length + 1)
 */
export function buildFilters(filters: SearchFilters, startIdx: number): BuiltFilters {
  const clauses: string[] = [];
  const params: string[] = [];
  let idx = startIdx;

  if (filters.sourceTypes?.length) {
    clauses.push(`AND source_type = ANY(string_to_array($${idx}::text, ','))`);
    params.push(filters.sourceTypes.join(","));
    idx++;
  }
  if (filters.sourceIds?.length) {
    clauses.push(`AND source_id::text = ANY(string_to_array($${idx}::text, ','))`);
    params.push(filters.sourceIds.join(","));
    idx++;
  }
  if (filters.languages?.length) {
    clauses.push(`AND language = ANY(string_to_array($${idx}::text, ','))`);
    params.push(filters.languages.join(","));
    idx++;
  }

  return { clause: clauses.join("\n            "), params };
}

/** Map a raw DB row to a RankedCandidate (shared by every leg). */
export function toRankedCandidate(row: Record<string, unknown>): RankedCandidate {
  return {
    content: row.content as string,
    sourceType: row.source_type as string,
    sourceId: row.source_id as string | null,
    metadata: (row.metadata as string) || "{}",
  };
}
