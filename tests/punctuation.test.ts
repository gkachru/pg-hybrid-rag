import { describe, expect, it } from "bun:test";
import { stripTrailingPunctuation } from "../src/punctuation.js";

describe("stripTrailingPunctuation", () => {
  it("strips English punctuation", () => {
    expect(stripTrailingPunctuation("phones?")).toBe("phones");
    expect(stripTrailingPunctuation("price!")).toBe("price");
    expect(stripTrailingPunctuation("hello.")).toBe("hello");
    expect(stripTrailingPunctuation("item,")).toBe("item");
    expect(stripTrailingPunctuation("list;")).toBe("list");
    expect(stripTrailingPunctuation("end:")).toBe("end");
  });

  it("strips Hindi punctuation", () => {
    expect(stripTrailingPunctuation("फोन।")).toBe("फोन");
    expect(stripTrailingPunctuation("दाम॥")).toBe("दाम");
  });

  it("strips Arabic punctuation", () => {
    expect(stripTrailingPunctuation("هاتف؟")).toBe("هاتف");
    expect(stripTrailingPunctuation("سعر،")).toBe("سعر");
    expect(stripTrailingPunctuation("قائمة؛")).toBe("قائمة");
  });

  it("strips multiple trailing punctuation", () => {
    expect(stripTrailingPunctuation("really?!")).toBe("really");
    expect(stripTrailingPunctuation("wow...")).toBe("wow");
  });

  it("preserves text without trailing punctuation", () => {
    expect(stripTrailingPunctuation("phones")).toBe("phones");
    expect(stripTrailingPunctuation("")).toBe("");
  });

  it("does not strip mid-word punctuation", () => {
    expect(stripTrailingPunctuation("it's")).toBe("it's");
    expect(stripTrailingPunctuation("co-op")).toBe("co-op");
  });
});
