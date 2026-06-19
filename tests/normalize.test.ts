import { describe, expect, it } from "bun:test";
import { LanguageNormalizer, normalizeForLanguage } from "../src/normalize.js";

describe("normalizeForLanguage (Arabic)", () => {
  it("strips tashkeel/diacritics", () => {
    expect(normalizeForLanguage("العِطْر", "ar")).toBe("العطر");
  });
  it("folds alef variants to bare alef", () => {
    expect(normalizeForLanguage("أحمد إإآ", "ar")).toBe("احمد ااا");
  });
  it("folds alef-maqsura to yeh by default", () => {
    expect(normalizeForLanguage("مصطفى", "ar")).toBe("مصطفي");
  });
  it("folds taa-marbuta to heh by default", () => {
    expect(normalizeForLanguage("مكتبة", "ar")).toBe("مكتبه");
  });
  it("strips tatweel/kashida", () => {
    expect(normalizeForLanguage("كــتــاب", "ar")).toBe("كتاب");
  });
  it("folds Arabic-Indic and extended digits to ASCII", () => {
    expect(normalizeForLanguage("٣٥٠ ۹", "ar")).toBe("350 9");
  });
  it("is idempotent", () => {
    const once = normalizeForLanguage("الأسْعار ٣٥٠", "ar");
    expect(normalizeForLanguage(once, "ar")).toBe(once);
  });
  it("respects locale subtags (ar-SA)", () => {
    expect(normalizeForLanguage("مكتبة", "ar-SA")).toBe("مكتبه");
  });
  it("can disable taa-marbuta and alef-maqsura folding", () => {
    expect(
      normalizeForLanguage("مكتبة مصطفى", "ar", {
        foldTaaMarbuta: false,
        foldAlefMaqsura: false,
      }),
    ).toBe("مكتبة مصطفى");
  });
  it("does NOT fold when language is not Arabic (gating)", () => {
    // Arabic text tagged 'en' is left alone (NFC only) — folding is language-gated.
    expect(normalizeForLanguage("مكتبة", "en")).toBe("مكتبة");
  });
  it("leaves Latin text unchanged (NFC passthrough)", () => {
    expect(normalizeForLanguage("Café", "en")).toBe("Café".normalize("NFC"));
  });
});

describe("LanguageNormalizer", () => {
  it("implements Normalizer and applies the Arabic ruleset", () => {
    const n = new LanguageNormalizer();
    expect(n.normalize("الْعِطْر", "ar")).toBe("العطر");
  });
  it("forwards options", () => {
    const n = new LanguageNormalizer({ foldTaaMarbuta: false });
    expect(n.normalize("مكتبة", "ar")).toBe("مكتبة");
  });
});
