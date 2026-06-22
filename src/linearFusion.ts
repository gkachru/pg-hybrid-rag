import { toRagResult } from "./fusionShared.js";
import type { FusionNormalizer, RagResult, RankedCandidate } from "./types.js";

/**
 * Normalize one leg's candidate scores into a comparable range so a weighted sum across legs
 * is meaningful (leg scales differ wildly: cosine 0–1, ts_rank tiny, bm25 unbounded).
 * Absent/non-finite scores are treated as 0.
 *  - "minmax": (s - min) / (max - min) → [0,1]. When max == min (single candidate or all-equal)
 *    every candidate normalizes to 1.0 (the leg cannot distinguish them; it fully endorses each).
 *  - "l2": s / sqrt(Σ sᵢ²) → preserves relative magnitude; a lone positive score → 1.0.
 */
function normalizeLeg(items: RankedCandidate[], method: FusionNormalizer): number[] {
  const scores = items.map((it) =>
    typeof it.score === "number" && Number.isFinite(it.score) ? it.score : 0,
  );
  if (scores.length === 0) return [];

  if (method === "l2") {
    const norm = Math.sqrt(scores.reduce((acc, x) => acc + x * x, 0));
    return norm > 0 ? scores.map((x) => x / norm) : scores.map(() => 0);
  }

  // minmax
  let min = scores[0];
  let max = scores[0];
  for (const x of scores) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (max === min) return scores.map(() => 1);
  return scores.map((x) => (x - min) / (max - min));
}

/**
 * Linear fusion: normalize each leg's scores independently, then a weighted sum across legs,
 * deduplicated by chunk id. An alternative to applyRRF that uses the legs' actual relevance
 * magnitudes (not just rank). Leg/weight order matches applyRRF: [vector, keyword, fts].
 */
export function applyLinearFusion(
  legs: Array<{ items: RankedCandidate[] }>,
  topK: number,
  weights?: number[],
  normalizer: FusionNormalizer = "minmax",
): RagResult[] {
  const scoreMap = new Map<string, { score: number; candidate: RankedCandidate }>();

  for (let legIdx = 0; legIdx < legs.length; legIdx++) {
    const leg = legs[legIdx];
    const w = weights?.[legIdx] ?? 1;
    const normalized = normalizeLeg(leg.items, normalizer);
    for (let i = 0; i < leg.items.length; i++) {
      const item = leg.items[i];
      const contribution = w * normalized[i];
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.score += contribution;
      } else {
        scoreMap.set(item.id, { score: contribution, candidate: item });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ score, candidate }) => toRagResult(candidate, score));
}
