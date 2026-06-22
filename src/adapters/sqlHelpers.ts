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
 * Comma-join filter values for the string_to_array(...) round-trip.
 * The values are bound as one comma-delimited text param and re-split in SQL, so a
 * comma inside any value would corrupt the filter. Reject it loudly instead.
 */
function joinFilterValues(field: string, values: string[]): string {
  for (const value of values) {
    if (value.includes(",")) {
      throw new Error(
        `${field} filter values must not contain a comma (got ${JSON.stringify(value)}); ` +
          "the string_to_array() binding splits on commas.",
      );
    }
  }
  return values.join(",");
}

/**
 * Build the shared source-type / source-id / language WHERE clauses.
 * Uses string_to_array(...) for driver-agnostic array binding (matches existing convention).
 * Filter values must not contain commas — see {@link joinFilterValues}.
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
    params.push(joinFilterValues("sourceTypes", filters.sourceTypes));
    idx++;
  }
  if (filters.sourceIds?.length) {
    clauses.push(`AND source_id::text = ANY(string_to_array($${idx}::text, ','))`);
    params.push(joinFilterValues("sourceIds", filters.sourceIds));
    idx++;
  }
  if (filters.languages?.length) {
    clauses.push(`AND language = ANY(string_to_array($${idx}::text, ','))`);
    params.push(joinFilterValues("languages", filters.languages));
    idx++;
  }

  return { clause: clauses.join("\n            "), params };
}

/** Map a raw DB row to a RankedCandidate (shared by every leg). */
export function toRankedCandidate(row: Record<string, unknown>): RankedCandidate {
  return {
    id: row.id as string,
    content: row.content as string,
    sourceType: row.source_type as string,
    sourceId: row.source_id as string | null,
    metadata: (row.metadata as string) || "{}",
    // Carry the leg's score only when present, so candidates built without a score column
    // (and existing exact-match test fixtures) keep the key absent rather than NaN.
    ...(row.score != null ? { score: Number(row.score) } : {}),
  };
}
