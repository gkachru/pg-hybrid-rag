import { describe, expect, it } from "bun:test";
import { parseMetadata, toRagResult } from "../src/fusionShared.js";

describe("parseMetadata", () => {
  it("parses a JSON object", () => {
    expect(parseMetadata('{"a":"b"}')).toEqual({ a: "b" });
  });
  it("returns {} for null/empty", () => {
    expect(parseMetadata(null)).toEqual({});
    expect(parseMetadata("")).toEqual({});
  });
  it("returns {} for malformed JSON", () => {
    expect(parseMetadata("{not json")).toEqual({});
  });
  it("returns {} for valid-but-non-object JSON", () => {
    for (const raw of ["42", "[1,2]", "null", '"s"', "true"]) {
      expect(parseMetadata(raw)).toEqual({});
    }
  });
});

describe("toRagResult", () => {
  it("maps a candidate + score into a RagResult with parsed metadata", () => {
    const r = toRagResult(
      { id: "x", content: "C", sourceType: "faq", sourceId: "1", metadata: '{"k":"v"}' },
      0.75,
    );
    expect(r).toEqual({
      content: "C",
      sourceType: "faq",
      sourceId: "1",
      score: 0.75,
      metadata: { k: "v" },
    });
  });
});
