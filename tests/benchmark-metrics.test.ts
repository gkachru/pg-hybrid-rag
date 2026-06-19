import { expect, test } from "bun:test";
import type { QueryOutcome } from "../examples/benchmark/metrics.js";
import {
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  sliceBy,
  summarize,
} from "../examples/benchmark/metrics.js";

test("recallAtK: 1 iff target within top-k", () => {
  expect(recallAtK(["a", "b", "c"], "b", 3)).toBe(1);
  expect(recallAtK(["a", "b", "c"], "b", 1)).toBe(0);
  expect(recallAtK(["a", "b", "c"], "z", 3)).toBe(0);
});

test("reciprocalRank: 1/rank of first hit within cap", () => {
  expect(reciprocalRank(["a", "b", "c"], "a")).toBe(1);
  expect(reciprocalRank(["a", "b", "c"], "c")).toBeCloseTo(1 / 3);
  expect(reciprocalRank(["x", "y"], "z")).toBe(0);
});

test("ndcgAtK: binary single-relevant", () => {
  expect(ndcgAtK(["a"], "a")).toBe(1);
  expect(ndcgAtK(["x", "a"], "a")).toBeCloseTo(1 / Math.log2(3));
  expect(ndcgAtK(["x", "y"], "a", 2)).toBe(0);
});

test("summarize + sliceBy", () => {
  const outcomes: QueryOutcome[] = [
    {
      rankedDocIds: ["a"],
      targetDoc: "a",
      dialect: "msa",
      domain: "banking",
      provider: "p",
      source: "faq",
    },
    {
      rankedDocIds: ["x", "b"],
      targetDoc: "b",
      dialect: "saudi",
      domain: "banking",
      provider: "p",
      source: "faq",
    },
  ];
  const s = summarize(outcomes);
  expect(s.n).toBe(2);
  expect(s.recallAt1).toBe(0.5);
  expect(s.recallAt3).toBe(1);
  expect(s.mrr10).toBeCloseTo((1 + 0.5) / 2);
  const byDialect = sliceBy(outcomes, (o) => o.dialect);
  expect(byDialect.get("msa")?.recallAt1).toBe(1);
  expect(byDialect.get("saudi")?.recallAt1).toBe(0);
});
