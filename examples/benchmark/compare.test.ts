import { describe, expect, test } from "bun:test";
import {
  compareConfigs,
  diffMaps,
  effectiveTolerance,
  loadBaselines,
  type Metrics,
  type ResultBundle,
} from "./compare.js";

const m = (n: number, v: number): Metrics => ({
  n,
  recallAt1: v,
  recallAt3: v,
  recallAt5: v,
  recallAt10: v,
  mrr10: v,
  ndcg10: v,
});

const bundle = (configs: ResultBundle["configs"]): ResultBundle => ({ configs });

describe("effectiveTolerance", () => {
  test("never tighter than one query's worth", () => {
    expect(effectiveTolerance(0.005, 75)).toBeCloseTo(1 / 75, 10);
    expect(effectiveTolerance(0.005, 1000)).toBe(0.005);
  });
});

describe("compareConfigs", () => {
  test("identical results are ok with zero deltas", () => {
    const cmp = compareConfigs(
      { a: m(267, 0.7) },
      bundle([{ name: "a", status: "ok", overall: m(267, 0.7) }]),
    );
    expect(cmp.ok).toBe(true);
    expect(cmp.deltas.every((d) => d.delta === 0)).toBe(true);
  });

  test("a single-query flip (exactly 1/n) is not flagged", () => {
    const cmp = compareConfigs(
      { a: m(75, 0.5) },
      bundle([{ name: "a", status: "ok", overall: m(75, 0.5 + 1 / 75) }]),
    );
    expect(cmp.ok).toBe(true);
  });

  test("a two-query move is flagged", () => {
    const cmp = compareConfigs(
      { a: m(75, 0.5) },
      bundle([{ name: "a", status: "ok", overall: m(75, 0.5 - 2 / 75) }]),
    );
    expect(cmp.ok).toBe(false);
    expect(cmp.deltas.filter((d) => d.flagged)).toHaveLength(6);
  });

  test("missing, failed and n-mismatched configs fail the comparison", () => {
    const cmp = compareConfigs(
      { gone: m(10, 0.5), broke: m(10, 0.5), resized: m(10, 0.5) },
      bundle([
        { name: "broke", status: "failed", error: "socket closed" },
        { name: "resized", status: "ok", overall: m(12, 0.5) },
        { name: "new", status: "ok", overall: m(10, 0.5) },
      ]),
    );
    expect(cmp.ok).toBe(false);
    expect(cmp.missing).toEqual(["gone"]);
    expect(cmp.failed).toEqual([{ config: "broke", error: "socket closed" }]);
    expect(cmp.nMismatch).toEqual([{ config: "resized", baseline: 10, actual: 12 }]);
    expect(cmp.extra).toEqual(["new"]);
  });
});

describe("diffMaps", () => {
  test("treats null and absent alike and reports real differences", () => {
    expect(diffMaps({ a: "1", b: null }, { a: "1" })).toEqual([]);
    expect(diffMaps({ EMBEDDING_MODEL: "BAAI/bge-m3" }, { EMBEDDING_MODEL: "e5" })).toEqual([
      { key: "EMBEDDING_MODEL", a: "BAAI/bge-m3", b: "e5" },
    ]);
  });
});

describe("committed baselines.json", () => {
  test("every suite is well-formed", () => {
    const { suites } = loadBaselines();
    expect(Object.keys(suites).length).toBeGreaterThan(0);
    for (const [key, s] of Object.entries(suites)) {
      expect(s.runner, key).toMatch(/^examples\/benchmark(-thai)?\/run\.ts$/);
      expect(Object.keys(s.configs).length, key).toBeGreaterThan(0);
      for (const metrics of Object.values(s.configs)) {
        expect(metrics.n, key).toBeGreaterThan(0);
        expect(metrics.ndcg10, key).toBeGreaterThanOrEqual(0);
        expect(metrics.ndcg10, key).toBeLessThanOrEqual(1);
      }
    }
  });
});
