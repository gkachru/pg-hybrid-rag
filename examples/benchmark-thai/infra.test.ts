import { describe, expect, test } from "bun:test";
import { createSegmenter } from "./infra";

describe("createSegmenter", () => {
  test("none → undefined", () => {
    expect(createSegmenter("none")).toBeUndefined();
  });
  test("intl → segments Thai, passes through English", () => {
    const s = createSegmenter("intl");
    expect(s?.segmentsLanguage("th")).toBe(true);
    expect(s?.segmentsLanguage("en")).toBe(false);
  });
  test("attacut → handles th / th-TH", () => {
    const s = createSegmenter("attacut");
    expect(s?.segmentsLanguage("th-TH")).toBe(true);
    expect(s?.segmentsLanguage("zh")).toBe(false);
  });
});
