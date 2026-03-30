import { describe, expect, it } from "bun:test";
import { Chunker } from "../src/Chunker.js";

describe("Chunker", () => {
  const chunker = new Chunker(100, 20);

  it("should return empty array for empty text", () => {
    expect(chunker.chunk("")).toHaveLength(0);
    expect(chunker.chunk("   ")).toHaveLength(0);
  });

  it("should return single chunk for short text", () => {
    const chunks = chunker.chunk("This is a short text.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("This is a short text.");
    expect(chunks[0].index).toBe(0);
  });

  it("should split on paragraph boundaries", () => {
    const text =
      "First paragraph with some content.\n\nSecond paragraph with more content.\n\nThird paragraph also has content.";
    const chunks = chunker.chunk(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("should include metadata in chunks", () => {
    const chunks = chunker.chunk("Test content", { sourceType: "product", id: "123" });
    expect(chunks[0].metadata).toEqual({ sourceType: "product", id: "123" });
  });

  it("should handle text without paragraph breaks", () => {
    const longSentence = "This is a very long sentence that goes on and on. ".repeat(10);
    const chunks = chunker.chunk(longSentence);
    expect(chunks.length).toBeGreaterThan(1);
    const joined = chunks.map((c) => c.content).join(" ");
    expect(joined.length).toBeGreaterThan(0);
  });

  it("should assign sequential indices", () => {
    const text = "Para one.\n\nPara two.\n\nPara three.\n\nPara four.\n\nPara five.";
    const chunks = new Chunker(30).chunk(text);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  describe("overlap", () => {
    it("chunks have overlapping content at boundaries", () => {
      const c = new Chunker(60, 20);
      const text =
        "The quick brown fox jumps over the lazy dog.\n\nThe rain in Spain stays mainly in the plain.";
      const chunks = c.chunk(text);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      const firstContent = chunks[0].content;
      const secondContent = chunks[1].content;
      const tail = firstContent.slice(-20);
      const lastWord = tail.split(" ").pop() ?? "";
      expect(secondContent).toContain(lastWord);
    });

    it("overlap aligns to word boundaries", () => {
      const c = new Chunker(50, 15);
      const text =
        "Alpha bravo charlie delta echo.\n\nFoxtrot golf hotel india juliet.\n\nKilo lima mike november.";
      const chunks = c.chunk(text);
      if (chunks.length >= 2) {
        expect(chunks[1].content).toMatch(/^[A-Za-z]/);
      }
    });

    it("overlap=0 produces no overlap", () => {
      const c = new Chunker(60, 0);
      const text =
        "First paragraph here with text.\n\nSecond paragraph here with text.\n\nThird paragraph here.";
      const chunks = c.chunk(text);
      if (chunks.length >= 2) {
        const firstWords = chunks[0].content.split(" ");
        const secondStart = chunks[1].content.split(" ")[0];
        const lastWordOfFirst = firstWords[firstWords.length - 1].replace(/[^a-zA-Z]/g, "");
        expect(secondStart).not.toBe(lastWordOfFirst);
      }
    });

    it("overlap works with sentence-split chunks", () => {
      const c = new Chunker(80, 20);
      const longPara =
        "The quick brown fox jumps over the lazy dog. The rain in Spain stays mainly in the plain. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump.";
      const chunks = c.chunk(longPara);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < chunks.length - 1; i++) {
        const tail = chunks[i].content.split(" ").slice(-2).join(" ");
        const lastWord = tail.split(" ").pop() ?? "";
        if (lastWord.length > 2) {
          expect(chunks[i + 1].content).toContain(lastWord);
        }
      }
    });

    it("single chunk text produces no overlap artifacts", () => {
      const c = new Chunker(500, 50);
      const chunks = c.chunk("Short text that fits in one chunk.");
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe("Short text that fits in one chunk.");
    });
  });
});
