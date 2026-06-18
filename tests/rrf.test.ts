import { describe, expect, it } from "bun:test";
import { applyRRF } from "../src/rrf.js";

describe("applyRRF", () => {
  it("fuses two legs with correct RRF scoring", () => {
    const results = applyRRF(
      [
        {
          items: [
            { id: "A", content: "A", sourceType: "faq", sourceId: "1", metadata: "{}" },
            { id: "B", content: "B", sourceType: "faq", sourceId: "2", metadata: "{}" },
          ],
        },
        {
          items: [
            { id: "B", content: "B", sourceType: "faq", sourceId: "2", metadata: "{}" },
            { id: "C", content: "C", sourceType: "faq", sourceId: "3", metadata: "{}" },
          ],
        },
      ],
      60,
      10,
    );
    // B appears in both legs → highest score
    expect(results[0].content).toBe("B");
    expect(results).toHaveLength(3);
  });

  it("respects topK limit", () => {
    const results = applyRRF(
      [
        {
          items: [
            { id: "A", content: "A", sourceType: "faq", sourceId: "1", metadata: "{}" },
            { id: "B", content: "B", sourceType: "faq", sourceId: "2", metadata: "{}" },
            { id: "C", content: "C", sourceType: "faq", sourceId: "3", metadata: "{}" },
          ],
        },
        { items: [] },
      ],
      60,
      2,
    );
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("A");
    expect(results[1].content).toBe("B");
  });

  it("returns empty array when both legs are empty", () => {
    const results = applyRRF([{ items: [] }, { items: [] }], 60, 5);
    expect(results).toHaveLength(0);
  });

  it("parses metadata JSON", () => {
    const results = applyRRF(
      [
        {
          items: [
            {
              id: "A",
              content: "A",
              sourceType: "faq",
              sourceId: "1",
              metadata: '{"category":"returns"}',
            },
          ],
        },
        { items: [] },
      ],
      60,
      5,
    );
    expect(results[0].metadata).toEqual({ category: "returns" });
  });

  it("returns empty metadata for malformed JSON instead of throwing", () => {
    const results = applyRRF(
      [
        {
          items: [
            {
              id: "a",
              content: "A",
              sourceType: "faq",
              sourceId: "1",
              metadata: "{not valid json",
            },
          ],
        },
        { items: [] },
      ],
      60,
      5,
    );
    expect(results[0].metadata).toEqual({});
  });

  it("returns empty metadata for valid-but-non-object JSON", () => {
    // applyRRF is public and may receive arbitrary rows. JSON that parses but is not a
    // plain object (number, array, null) must not leak through typed as Record<string, string>.
    for (const raw of ["42", "[1,2]", "null", '"a string"', "true"]) {
      const results = applyRRF(
        [
          {
            items: [{ id: "a", content: "A", sourceType: "faq", sourceId: "1", metadata: raw }],
          },
          { items: [] },
        ],
        60,
        5,
      );
      expect(results[0].metadata).toEqual({});
    }
  });

  it("keeps distinct chunks that share identical content separate", () => {
    // Two different chunks (distinct ids) with byte-identical content must NOT be merged.
    const results = applyRRF(
      [
        { items: [{ id: "x", content: "dup", sourceType: "faq", sourceId: "1", metadata: "{}" }] },
        { items: [{ id: "y", content: "dup", sourceType: "faq", sourceId: "2", metadata: "{}" }] },
      ],
      60,
      10,
    );
    expect(results).toHaveLength(2);
  });

  it("vectorWeight biases ranking toward the weighted leg", () => {
    const vectorItems = [
      { id: "v1", content: "Vector top", sourceType: "faq", sourceId: "v1", metadata: "{}" },
    ];
    const keywordItems = [
      { id: "k1", content: "Keyword top", sourceType: "faq", sourceId: "k1", metadata: "{}" },
    ];

    const highVector = applyRRF(
      [{ items: vectorItems }, { items: keywordItems }],
      60,
      10,
      [0.9, 0.1],
    );
    expect(highVector[0].content).toBe("Vector top");

    const highKeyword = applyRRF(
      [{ items: vectorItems }, { items: keywordItems }],
      60,
      10,
      [0.1, 0.9],
    );
    expect(highKeyword[0].content).toBe("Keyword top");
  });

  it("higher rrfK flattens rank differences", () => {
    const items = [
      { id: "A", content: "A", sourceType: "faq", sourceId: "1", metadata: "{}" },
      { id: "B", content: "B", sourceType: "faq", sourceId: "2", metadata: "{}" },
    ];
    const lowK = applyRRF([{ items }], 1, 10);
    const highK = applyRRF([{ items }], 200, 10);

    const lowDiff = lowK[0].score - lowK[1].score;
    const highDiff = highK[0].score - highK[1].score;
    expect(highDiff).toBeLessThan(lowDiff);
  });

  it("supports 3 legs with weights", () => {
    const results = applyRRF(
      [
        { items: [{ id: "V", content: "V", sourceType: "faq", sourceId: "1", metadata: "{}" }] },
        { items: [{ id: "K", content: "K", sourceType: "faq", sourceId: "2", metadata: "{}" }] },
        { items: [{ id: "F", content: "F", sourceType: "faq", sourceId: "3", metadata: "{}" }] },
      ],
      60,
      10,
      [1, 1, 1],
    );
    expect(results).toHaveLength(3);
    expect(results[0].score).toBeCloseTo(results[1].score, 5);
    expect(results[1].score).toBeCloseTo(results[2].score, 5);
  });

  it("defaults a missing leg weight to 1 instead of producing a NaN score", () => {
    // weights is shorter than legs — the third leg has no entry. It must default to 1,
    // not `undefined` (which makes w/(k+rank) === NaN, sorting unpredictably and failing
    // the downstream minRelevance filter). Reachable only via the public applyRRF API.
    const results = applyRRF(
      [
        { items: [{ id: "V", content: "V", sourceType: "faq", sourceId: "1", metadata: "{}" }] },
        { items: [{ id: "K", content: "K", sourceType: "faq", sourceId: "2", metadata: "{}" }] },
        { items: [{ id: "F", content: "F", sourceType: "faq", sourceId: "3", metadata: "{}" }] },
      ],
      60,
      10,
      [1, 1], // only two weights for three legs
    );
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
    }
    // The unweighted third leg must score the same as the two weight-1 legs (all rank 0).
    const f = results.find((r) => r.content === "F");
    expect(f?.score).toBeCloseTo(1 / 61, 5);
  });
});
