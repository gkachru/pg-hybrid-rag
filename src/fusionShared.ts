import type { RagResult, RankedCandidate } from "./types.js";

/**
 * Parse a candidate's metadata JSON, falling back to {} on malformed or non-object input.
 * The fusion functions are public and may receive arbitrary rows, so a bad value must not throw.
 */
export function parseMetadata(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || "{}");
    // Reject valid-but-non-object JSON (numbers, arrays, null) so it isn't returned
    // typed as Record<string, string>. Library rows are always objects, but callers are public.
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/** Map a fused candidate + its computed fusion score into the public RagResult shape. */
export function toRagResult(candidate: RankedCandidate, score: number): RagResult {
  return {
    content: candidate.content,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    score,
    metadata: parseMetadata(candidate.metadata),
  };
}
