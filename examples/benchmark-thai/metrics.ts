import type { Register } from "./types.js";

/** 1 if targetDoc appears among the first k ranked doc ids, else 0. */
export function recallAtK(rankedDocIds: string[], targetDoc: string, k: number): number {
  return rankedDocIds.slice(0, k).includes(targetDoc) ? 1 : 0;
}

/** Reciprocal rank of the first occurrence of targetDoc within `cap` (0 if absent). */
export function reciprocalRank(rankedDocIds: string[], targetDoc: string, cap = 10): number {
  const idx = rankedDocIds.slice(0, cap).indexOf(targetDoc);
  return idx === -1 ? 0 : 1 / (idx + 1);
}

/** Binary-relevance nDCG@k for a single relevant doc (IDCG = 1). */
export function ndcgAtK(rankedDocIds: string[], targetDoc: string, k = 10): number {
  const idx = rankedDocIds.slice(0, k).indexOf(targetDoc);
  return idx === -1 ? 0 : 1 / Math.log2(idx + 2);
}

export interface QueryOutcome {
  rankedDocIds: string[];
  targetDoc: string;
  register: Register;
  domain: string;
  provider: string;
  loanword: boolean;
  source: string;
}

export interface MetricSummary {
  n: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  recallAt10: number;
  mrr10: number;
  ndcg10: number;
}

export function summarize(outcomes: QueryOutcome[]): MetricSummary {
  const n = outcomes.length;
  const empty: MetricSummary = {
    n: 0,
    recallAt1: 0,
    recallAt3: 0,
    recallAt5: 0,
    recallAt10: 0,
    mrr10: 0,
    ndcg10: 0,
  };
  if (n === 0) return empty;
  const mean = (f: (o: QueryOutcome) => number) => outcomes.reduce((s, o) => s + f(o), 0) / n;
  return {
    n,
    recallAt1: mean((o) => recallAtK(o.rankedDocIds, o.targetDoc, 1)),
    recallAt3: mean((o) => recallAtK(o.rankedDocIds, o.targetDoc, 3)),
    recallAt5: mean((o) => recallAtK(o.rankedDocIds, o.targetDoc, 5)),
    recallAt10: mean((o) => recallAtK(o.rankedDocIds, o.targetDoc, 10)),
    mrr10: mean((o) => reciprocalRank(o.rankedDocIds, o.targetDoc, 10)),
    ndcg10: mean((o) => ndcgAtK(o.rankedDocIds, o.targetDoc, 10)),
  };
}

/** Group outcomes by a key function and summarize each group. */
export function sliceBy(
  outcomes: QueryOutcome[],
  key: (o: QueryOutcome) => string,
): Map<string, MetricSummary> {
  const groups = new Map<string, QueryOutcome[]>();
  for (const o of outcomes) {
    const k = key(o);
    const g = groups.get(k) ?? [];
    g.push(o);
    groups.set(k, g);
  }
  const out = new Map<string, MetricSummary>();
  for (const [k, v] of groups) out.set(k, summarize(v));
  return out;
}
