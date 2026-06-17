import { describe, expect, it } from "bun:test";
import { buildFilters, toRankedCandidate } from "../src/adapters/sqlHelpers.js";

describe("buildFilters", () => {
  it("returns empty clause + params when no filters are set", () => {
    const f = buildFilters({}, 5);
    expect(f.clause).toBe("");
    expect(f.params).toEqual([]);
  });

  it("builds a source_type clause at the start index", () => {
    const f = buildFilters({ sourceTypes: ["product", "faq"] }, 5);
    expect(f.clause).toContain("source_type = ANY(string_to_array($5::text, ','))");
    expect(f.params).toEqual(["product,faq"]);
  });

  it("assigns sequential placeholders for all three filters in order", () => {
    const f = buildFilters(
      { sourceTypes: ["product"], sourceIds: ["a"], languages: ["en", "hi"] },
      5,
    );
    expect(f.clause).toContain("source_type = ANY(string_to_array($5::text, ','))");
    expect(f.clause).toContain("source_id::text = ANY(string_to_array($6::text, ','))");
    expect(f.clause).toContain("language = ANY(string_to_array($7::text, ','))");
    expect(f.params).toEqual(["product", "a", "en,hi"]);
  });

  it("skips empty filter arrays", () => {
    const f = buildFilters({ sourceTypes: [], languages: ["en"] }, 5);
    expect(f.clause).not.toContain("source_type");
    expect(f.clause).toContain("language = ANY(string_to_array($5::text, ','))");
    expect(f.params).toEqual(["en"]);
  });
});

describe("toRankedCandidate", () => {
  it("maps a row, defaulting null metadata to '{}'", () => {
    expect(
      toRankedCandidate({
        id: "chunk-1",
        content: "c",
        source_type: "faq",
        source_id: null,
        metadata: null,
      }),
    ).toEqual({ id: "chunk-1", content: "c", sourceType: "faq", sourceId: null, metadata: "{}" });
  });

  it("preserves existing metadata", () => {
    expect(
      toRankedCandidate({
        id: "chunk-2",
        content: "c",
        source_type: "faq",
        source_id: "1",
        metadata: '{"a":"b"}',
      }),
    ).toEqual({
      id: "chunk-2",
      content: "c",
      sourceType: "faq",
      sourceId: "1",
      metadata: '{"a":"b"}',
    });
  });
});
