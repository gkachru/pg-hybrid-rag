import type { RagResult, RankedCandidate } from "./types.js";

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
      // Deduplicate by content (same chunk may appear in both legs)
      const key = item.content;
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
      metadata: JSON.parse(candidate.metadata || "{}"),
    }));
}
