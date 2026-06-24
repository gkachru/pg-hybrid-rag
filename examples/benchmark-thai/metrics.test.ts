import { describe, expect, test } from "bun:test";
import {
  ndcgAtK,
  type QueryOutcome,
  recallAtK,
  reciprocalRank,
  sliceBy,
  summarize,
} from "./metrics";

const oc = (ranked: string[], target: string, over: Partial<QueryOutcome> = {}): QueryOutcome => ({
  rankedDocIds: ranked,
  targetDoc: target,
  register: "written",
  domain: "telecom",
  provider: "ais",
  loanword: false,
  source: "faq",
  ...over,
});

describe("metrics", () => {
  test("recallAtK: hit within k vs outside k", () => {
    expect(recallAtK(["a", "b", "c"], "c", 3)).toBe(1);
    expect(recallAtK(["a", "b", "c"], "c", 2)).toBe(0);
  });
  test("reciprocalRank: 1/(rank+1), 0 if absent", () => {
    expect(reciprocalRank(["a", "b"], "b")).toBe(0.5);
    expect(reciprocalRank(["a"], "z")).toBe(0);
  });
  test("ndcgAtK: 1/log2(idx+2)", () => {
    expect(ndcgAtK(["x", "t"], "t")).toBeCloseTo(1 / Math.log2(3));
  });
  test("summarize: averages and counts", () => {
    const m = summarize([oc(["t"], "t"), oc(["x"], "t")]);
    expect(m.n).toBe(2);
    expect(m.recallAt1).toBe(0.5);
  });
  test("summarize: empty → zeros", () => {
    expect(summarize([]).n).toBe(0);
  });
  test("sliceBy register groups", () => {
    const g = sliceBy(
      [oc(["t"], "t", { register: "written" }), oc(["t"], "t", { register: "spoken" })],
      (o) => o.register,
    );
    expect([...g.keys()].sort()).toEqual(["spoken", "written"]);
  });
});
