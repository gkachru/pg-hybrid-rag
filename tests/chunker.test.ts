import { describe, expect, it } from "bun:test";
import { Chunker } from "../src/Chunker.js";

describe("Chunker (character-based)", () => {
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

describe("Chunker (token-limit mode)", () => {
  const chunker = new Chunker({ tokenLimit: 512, overlap: 20 });

  it("produces larger chunks for English than character-based default", () => {
    // 512 tokens × 3.2 chars/token = 1638 char limit
    const text = "The quick brown fox. ".repeat(80); // ~1600 chars
    const charChunker = new Chunker(512, 20);

    const tokenChunks = chunker.chunk(text, { language: "en" });
    const charChunks = charChunker.chunk(text);

    expect(tokenChunks.length).toBeLessThan(charChunks.length);
  });

  it("uses ~1638 char limit for Latin languages", () => {
    // Each sentence is ~50 chars, so 30 sentences ≈ 1500 chars fits in 1 chunk
    const text = "This is a sentence with some words in it. ".repeat(30);
    const chunks = chunker.chunk(text, { language: "en" });
    expect(chunks).toHaveLength(1);
  });

  it("uses smaller limit for CJK languages", () => {
    // 512 tokens × 1.2 chars/token = 614 char limit
    // 700 CJK chars should split into 2 chunks
    const text = "这是一个测试句子。".repeat(78); // ~702 chars
    const chunks = chunker.chunk(text, { language: "zh" });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("falls back to tokenLimit as char limit for unknown languages", () => {
    // Unknown language → 512 char limit (same as old default)
    const text = "A".repeat(600);
    const chunks = chunker.chunk(text, { language: "xx" });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("normalizes BCP-47 codes to base language", () => {
    const text = "This is a sentence with some words in it. ".repeat(30);
    const chunksEn = chunker.chunk(text, { language: "en" });
    const chunksEnUs = chunker.chunk(text, { language: "en-US" });
    expect(chunksEn.length).toBe(chunksEnUs.length);
  });

  it("handles Hindi with intermediate char limit", () => {
    // 512 × 2.4 = 1228 chars
    const text = "यह एक परीक्षण वाक्य है। ".repeat(55); // ~1320 chars
    const chunks = chunker.chunk(text, { language: "hi" });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("handles Arabic with intermediate char limit", () => {
    // 512 × 2.4 = 1228 chars
    const text = "هذه جملة اختبار طويلة. ".repeat(55); // ~1265 chars
    const chunks = chunker.chunk(text, { language: "ar" });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("works without language in metadata (falls back to tokenLimit)", () => {
    const text = "A".repeat(600);
    const chunks = chunker.chunk(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("still supports metadata fields alongside language", () => {
    const chunks = chunker.chunk("Short text.", { language: "en", name: "Test Product" });
    expect(chunks[0].metadata.language).toBe("en");
    expect(chunks[0].metadata.name).toBe("Test Product");
  });
});

describe("Chunker prefixFn", () => {
  it("prepends prefix returned by prefixFn", () => {
    const c = new Chunker({
      tokenLimit: 512,
      prefixFn: (m) => (m.name ? `[${m.name}]` : undefined),
    });
    const chunks = c.chunk("Some content.", { name: "Widget" });
    expect(chunks[0].content).toBe("[Widget] Some content.");
  });

  it("does not prefix when prefixFn returns undefined", () => {
    const c = new Chunker({
      tokenLimit: 512,
      prefixFn: (m) => (m.name ? `[${m.name}]` : undefined),
    });
    const chunks = c.chunk("Some content.", { language: "en" });
    expect(chunks[0].content).toBe("Some content.");
  });

  it("does not prefix when prefixFn is not set", () => {
    const c = new Chunker({ tokenLimit: 512 });
    const chunks = c.chunk("Some content.", { name: "Widget" });
    expect(chunks[0].content).toBe("Some content.");
  });

  it("skips prefix when chunk already starts with the label", () => {
    const c = new Chunker({
      tokenLimit: 512,
      prefixFn: () => "[Widget]",
    });
    const chunks = c.chunk("[Widget] Already prefixed.", { name: "Widget" });
    expect(chunks[0].content).toBe("[Widget] Already prefixed.");
  });

  it("supports name+brand pattern via prefixFn", () => {
    const c = new Chunker({
      tokenLimit: 512,
      prefixFn: (m) => (m.brand ? `[${m.name} | ${m.brand}]` : m.name ? `[${m.name}]` : undefined),
    });
    const chunks = c.chunk("Some content.", { name: "Widget", brand: "Acme" });
    expect(chunks[0].content).toBe("[Widget | Acme] Some content.");
  });
});
