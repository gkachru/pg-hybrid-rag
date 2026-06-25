import { describe, expect, it } from "bun:test";
import { detectLanguage } from "../src/language.js";
import { normalizeForLanguage } from "../src/normalize.js";
import {
  CJK_LANGUAGES,
  RECOMMENDED_DIMENSIONS,
  RECOMMENDED_EMBEDDER,
  RECOMMENDED_MAX_TOKENS,
  RECOMMENDED_VECTOR_MIN_SCORE,
  recommendForLanguage,
} from "../src/recommend.js";

describe("recommendForLanguage", () => {
  it("recommends the multilingual embedder + calibrated floor for every language", () => {
    for (const lang of ["en", "de", "ar", "th", "zh", "ja", "ko", "xx"]) {
      const rec = recommendForLanguage(lang);
      expect(rec.embedder).toBe(RECOMMENDED_EMBEDDER);
      expect(rec.embedder).toBe("BAAI/bge-m3");
      expect(rec.dimensions).toBe(RECOMMENDED_DIMENSIONS);
      expect(rec.dimensions).toBe(1024);
      expect(rec.maxTokens).toBe(RECOMMENDED_MAX_TOKENS);
      expect(rec.maxTokens).toBe(8192);
      expect(rec.vectorMinScore).toBe(RECOMMENDED_VECTOR_MIN_SCORE);
      expect(rec.vectorMinScore).toBe(0.4);
    }
  });

  it("resolves the representative per-language structural table", () => {
    expect(recommendForLanguage("en")).toEqual({
      embedder: "BAAI/bge-m3",
      dimensions: 1024,
      maxTokens: 8192,
      vectorMinScore: 0.4,
      stemming: "english",
      needsNormalization: false,
      isCjk: false,
    });
    expect(recommendForLanguage("de")).toMatchObject({
      stemming: "german",
      needsNormalization: false,
      isCjk: false,
    });
    expect(recommendForLanguage("ar")).toMatchObject({
      stemming: "arabic",
      needsNormalization: true,
      isCjk: false,
    });
    expect(recommendForLanguage("th")).toMatchObject({
      stemming: "none",
      needsNormalization: true,
      isCjk: false,
    });
    expect(recommendForLanguage("zh")).toMatchObject({
      stemming: "none",
      needsNormalization: false,
      isCjk: true,
    });
    expect(recommendForLanguage("ja")).toMatchObject({ stemming: "none", isCjk: true });
    expect(recommendForLanguage("ko")).toMatchObject({ stemming: "none", isCjk: true });
  });

  it("ignores the region subtag (ar-SA → ar, en-US → en, en-GB → en)", () => {
    expect(recommendForLanguage("ar-SA").stemming).toBe("arabic");
    expect(recommendForLanguage("ar-SA").needsNormalization).toBe(true);
    expect(recommendForLanguage("en-US").stemming).toBe("english");
    // base-code fallback stems an unlisted region (en-GB) as english too
    expect(recommendForLanguage("en-GB").stemming).toBe("english");
  });

  it("returns the lenient multilingual default for unknown/empty codes (no throw)", () => {
    expect(recommendForLanguage("xx")).toEqual({
      embedder: "BAAI/bge-m3",
      dimensions: 1024,
      maxTokens: 8192,
      vectorMinScore: 0.4,
      stemming: "none",
      needsNormalization: false,
      isCjk: false,
    });
    expect(() => recommendForLanguage("")).not.toThrow();
    expect(recommendForLanguage("").stemming).toBe("none");
  });

  it("isCjk agrees with detectLanguage's CJK outputs", () => {
    expect(detectLanguage("日本語のテキストです")).toBe("ja");
    expect(detectLanguage("한국어 텍스트입니다")).toBe("ko");
    expect(detectLanguage("中文文本内容")).toBe("zh");
    for (const lang of CJK_LANGUAGES) {
      expect(recommendForLanguage(lang).isCjk).toBe(true);
    }
    expect(recommendForLanguage("en").isCjk).toBe(false);
  });

  it("needsNormalization agrees with normalizeForLanguage being non-identity", () => {
    // ar: hamza-above alef folds to bare alef → string changes
    expect(normalizeForLanguage("أحمد", "ar")).not.toBe("أحمد");
    expect(recommendForLanguage("ar").needsNormalization).toBe(true);
    // th: Thai digits fold to ASCII → string changes
    expect(normalizeForLanguage("๑๒๓", "th")).toBe("123");
    expect(recommendForLanguage("th").needsNormalization).toBe(true);
    // en: NFC-only, identity on plain ASCII
    expect(normalizeForLanguage("Hello", "en")).toBe("Hello");
    expect(recommendForLanguage("en").needsNormalization).toBe(false);
  });
});
