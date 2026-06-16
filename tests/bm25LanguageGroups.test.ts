import { describe, expect, it } from "bun:test";
import {
  BM25_LANGUAGE_GROUPS,
  bm25LanguagePredicate,
  bm25SupportedLanguages,
} from "../src/adapters/fts/bm25LanguageGroups.js";

describe("bm25LanguagePredicate", () => {
  it("returns the English group IN-list for en", () => {
    expect(bm25LanguagePredicate("en")).toBe("language IN ('en', 'en-US', 'en-IN')");
  });

  it("matches a locale code within a group", () => {
    expect(bm25LanguagePredicate("es-MX")).toBe("language IN ('es', 'es-ES', 'es-MX')");
  });

  it("returns a NOT IN catch-all for unsupported languages", () => {
    const pred = bm25LanguagePredicate("hi");
    expect(pred.startsWith("language NOT IN (")).toBe(true);
    expect(pred).toContain("'en'");
    expect(pred).not.toContain("'hi'");
  });
});

describe("bm25SupportedLanguages", () => {
  it("flattens every group's language codes", () => {
    const all = bm25SupportedLanguages();
    expect(all).toContain("en");
    expect(all).toContain("ro-RO");
    expect(all.length).toBe(BM25_LANGUAGE_GROUPS.flatMap((g) => g.languages).length);
  });
});
