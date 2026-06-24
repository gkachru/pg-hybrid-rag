import { describe, expect, it } from "bun:test";
import { IntlSegmenterAdapter } from "../src/adapters/IntlSegmenter.js";

describe("IntlSegmenterAdapter", () => {
  it("passes through a language it is not configured for (unchanged)", () => {
    const seg = new IntlSegmenterAdapter({ languages: ["th"] });
    expect(seg.segment("hello world", "en")).toBe("hello world");
  });

  it("reports handled languages via segmentsLanguage (base subtag match)", () => {
    const seg = new IntlSegmenterAdapter({ languages: ["th", "zh"] });
    expect(seg.segmentsLanguage("th")).toBe(true);
    expect(seg.segmentsLanguage("th-TH")).toBe(true);
    expect(seg.segmentsLanguage("zh")).toBe(true);
    expect(seg.segmentsLanguage("en")).toBe(false);
  });

  it("inserts spaces only — preserves the non-whitespace character sequence (space-insertion contract)", () => {
    const seg = new IntlSegmenterAdapter({ languages: ["th"] });
    const input = "ผมอยากเปลี่ยนแพ็กเกจอินเทอร์เน็ต";
    const out = seg.segment(input, "th");
    // Structural assertion (NOT exact segmentation — that is ICU-dependent):
    // removing all whitespace recovers the original exactly.
    expect(out.replace(/\s+/g, "")).toBe(input);
  });

  it("returns empty string for empty input", () => {
    const seg = new IntlSegmenterAdapter({ languages: ["th"] });
    expect(seg.segment("", "th")).toBe("");
  });
});
