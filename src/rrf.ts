import type { RagResult, RankedCandidate } from "./types.js";

/**
 * Parse a candidate's metadata JSON, falling back to {} on malformed input.
 * applyRRF is public and may receive arbitrary rows, so a bad value must not throw.
 */
function parseMetadata(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || "{}");
    // Reject valid-but-non-object JSON (numbers, arrays, null) so it isn't returned
    // typed as Record<string, string>. Library rows are always objects, but applyRRF is public.
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Reciprocal Rank Fusion: merge ranked lists into a single score.
 * rrf_score(doc) = weight_i / (k + rank_i) for each leg where doc appears.
 * When no weights are provided, all legs are weighted equally at 1.
 */
export function applyRRF(
  legs: Array<{ items: RankedCandidate[] }>,
  rrfK: number,
  topK: number,
  weights?: number[],
): RagResult[] {
  const scoreMap = new Map<string, { score: number; candidate: RankedCandidate }>();

  for (let legIdx = 0; legIdx < legs.length; legIdx++) {
    const leg = legs[legIdx];
    const w = weights ? weights[legIdx] : 1;
    for (let rank = 0; rank < leg.items.length; rank++) {
      const item = leg.items[rank];
      // Deduplicate by stable chunk id (same chunk may appear in multiple legs).
      // Keying on id — not content — keeps distinct chunks with identical text separate.
      const key = item.id;
      const rrfScore = w / (rrfK + rank + 1);

      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, candidate: item });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ score, candidate }) => ({
      content: candidate.content,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      score,
      metadata: parseMetadata(candidate.metadata),
    }));
}
