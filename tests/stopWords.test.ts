import { describe, expect, it } from "bun:test";
import { removeStopWords } from "../src/stopWords.js";

describe("removeStopWords", () => {
  const englishStopWords = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "in",
    "on",
    "for",
    "to",
    "of",
    "with",
    "and",
    "but",
    "or",
    "not",
    "it",
    "this",
    "that",
    "i",
    "me",
    "my",
  ]);

  it("removes basic English stop words", () => {
    expect(removeStopWords("the best phones in the market", englishStopWords)).toBe(
      "best phones market",
    );
  });

  it("preserves ecommerce-relevant terms", () => {
    const result = removeStopWords("show me the best phones under 10000", englishStopWords);
    expect(result).toContain("show");
    expect(result).toContain("best");
    expect(result).toContain("phones");
    expect(result).toContain("under");
    expect(result).toContain("10000");
    expect(result).not.toContain("me");
    expect(result).not.toContain("the");
  });

  it("returns empty string when all words are stop words", () => {
    expect(removeStopWords("the a an is", englishStopWords)).toBe("");
  });

  it("is case-insensitive", () => {
    expect(removeStopWords("The Best Phones In The Market", englishStopWords)).toBe(
      "Best Phones Market",
    );
  });

  it("returns original query when stop words set is empty", () => {
    expect(removeStopWords("show me the best phones", new Set())).toBe("show me the best phones");
  });

  it("handles multiple spaces", () => {
    expect(removeStopWords("the  best   phones  in   the   market", englishStopWords)).toBe(
      "best phones market",
    );
  });

  it("handles Hindi stop words", () => {
    const hindiStopWords = new Set(["है", "में", "का", "की", "के", "और", "को"]);
    expect(removeStopWords("फोन का दाम कितना है", hindiStopWords)).toBe("फोन दाम कितना");
  });

  it("handles Arabic stop words", () => {
    const arabicStopWords = new Set(["في", "من", "على", "هذا", "هي"]);
    expect(removeStopWords("أفضل هاتف في السوق", arabicStopWords)).toBe("أفضل هاتف السوق");
  });
});
