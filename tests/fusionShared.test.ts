import { describe, expect, it } from "bun:test";
import { parseMetadata, toRagResult } from "../src/fusionShared.js";
import { parseAttributes } from "../src/metadata/attributes.js";

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
      attributes: [],
    });
  });
});

describe("toRagResult attributes", () => {
  const base = { id: "x", content: "C", sourceType: "faq", sourceId: "1", metadata: "{}" };
  it("returns parsed attributes", () => {
    const raw = JSON.stringify([{ ns: "", k: "region", t: "string", v: "EU", l: "eu" }]);
    const r = toRagResult({ ...base, attributes: raw }, 1);
    expect(r.attributes).toEqual(parseAttributes(raw));
    expect(r.attributes).toEqual([{ ns: "", key: "region", type: "string", value: "EU" }]);
  });
  it("yields [] when absent or malformed", () => {
    expect(toRagResult(base, 1).attributes).toEqual([]);
    expect(toRagResult({ ...base, attributes: "{nope" }, 1).attributes).toEqual([]);
  });
});
