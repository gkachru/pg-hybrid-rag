import { describe, expect, it } from "bun:test";
import { applyLinearFusion } from "../src/linearFusion.js";

const c = (id: string, score?: number) => ({
  id,
  content: id,
  sourceType: "faq",
  sourceId: id,
  metadata: "{}",
  ...(score === undefined ? {} : { score }),
});

describe("applyLinearFusion", () => {
  it("minmax: orders by normalized score within a single leg", () => {
    // raw [0.95, 0.80, 0.55] -> minmax [1.0, 0.625, 0.0]
    const out = applyLinearFusion([{ items: [c("hi", 0.95), c("mid", 0.8), c("lo", 0.55)] }], 10);
    expect(out.map((r) => r.content)).toEqual(["hi", "mid", "lo"]);
    expect(out[0].score).toBeCloseTo(1.0, 6);
    expect(out[1].score).toBeCloseTo(0.625, 6);
    expect(out[2].score).toBeCloseTo(0.0, 6);
  });

  it("l2: normalizes by vector norm, preserving relative magnitude", () => {
    // raw [0.95, 0.80, 0.55], norm = sqrt(0.95^2+0.8^2+0.55^2) ~= 1.3454
    const out = applyLinearFusion(
      [{ items: [c("a", 0.95), c("b", 0.8), c("c", 0.55)] }],
      10,
      undefined,
      "l2",
    );
    const norm = Math.sqrt(0.95 ** 2 + 0.8 ** 2 + 0.55 ** 2);
    expect(out[0].score).toBeCloseTo(0.95 / norm, 6);
    expect(out[2].score).toBeCloseTo(0.55 / norm, 6);
  });

  it("weighted sum across legs dedups by id", () => {
    // vector: A=1.0,B=0.0 (minmax of [0.9,0.5]); keyword: A=1.0 (single -> 1.0)
    // weights [1,2]: A = 1*1.0 + 2*1.0 = 3.0; B = 1*0.0 = 0.0
    const out = applyLinearFusion(
      [{ items: [c("A", 0.9), c("B", 0.5)] }, { items: [c("A", 0.3)] }],
      10,
      [1, 2],
    );
    expect(out[0].content).toBe("A");
    expect(out[0].score).toBeCloseTo(3.0, 6);
    const b = out.find((r) => r.content === "B");
    expect(b?.score).toBeCloseTo(0.0, 6);
  });

  it("minmax: a single-candidate or all-equal leg normalizes to 1.0", () => {
    const single = applyLinearFusion([{ items: [c("only", 0.42)] }], 10);
    expect(single[0].score).toBeCloseTo(1.0, 6);
    const equal = applyLinearFusion([{ items: [c("x", 0.5), c("y", 0.5)] }], 10);
    expect(equal[0].score).toBeCloseTo(1.0, 6);
    expect(equal[1].score).toBeCloseTo(1.0, 6);
  });

  it("treats an absent or non-finite score as 0", () => {
    // both scores absent -> [0,0] -> minmax max==min -> both 1.0 (degenerate rule)
    const out = applyLinearFusion([{ items: [c("p"), c("q")] }], 10);
    expect(out.every((r) => Number.isFinite(r.score))).toBe(true);
  });

  it("skips an empty leg and respects topK", () => {
    const out = applyLinearFusion(
      [{ items: [c("A", 0.9), c("B", 0.5), c("C", 0.1)] }, { items: [] }],
      2,
    );
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.content)).toEqual(["A", "B"]);
  });

  it("parses metadata via the shared mapper", () => {
    const out = applyLinearFusion(
      [
        {
          items: [
            {
              id: "m",
              content: "M",
              sourceType: "faq",
              sourceId: "1",
              metadata: '{"k":"v"}',
              score: 1,
            },
          ],
        },
      ],
      10,
    );
    expect(out[0].metadata).toEqual({ k: "v" });
  });
});
