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

  it("strips trailing closing brackets, quotes, and ellipsis", () => {
    expect(stripTrailingPunctuation("phones)")).toBe("phones");
    expect(stripTrailingPunctuation("phones]")).toBe("phones");
    expect(stripTrailingPunctuation("phones}")).toBe("phones");
    expect(stripTrailingPunctuation('phones"')).toBe("phones");
    expect(stripTrailingPunctuation("phones'")).toBe("phones");
    expect(stripTrailingPunctuation("phones…")).toBe("phones"); // U+2026 ellipsis
    expect(stripTrailingPunctuation("phones’")).toBe("phones"); // U+2019 right single quote
    expect(stripTrailingPunctuation("phones”")).toBe("phones"); // U+201D right double quote
  });

  it("preserves text without trailing punctuation", () => {
    expect(stripTrailingPunctuation("phones")).toBe("phones");
    expect(stripTrailingPunctuation("")).toBe("");
  });

  it("does not strip mid-word punctuation", () => {
    expect(stripTrailingPunctuation("it's")).toBe("it's");
    expect(stripTrailingPunctuation("co-op")).toBe("co-op");
  });

  it("strips a trailing Thai mai yamok (ๆ)", () => {
    expect(stripTrailingPunctuation("เด็กๆ")).toBe("เด็ก");
  });

  it("keeps Thai paiyannoi (ฯ), including ฯลฯ ('etc.')", () => {
    expect(stripTrailingPunctuation("กรุงเทพฯ")).toBe("กรุงเทพฯ");
    expect(stripTrailingPunctuation("ฯลฯ")).toBe("ฯลฯ");
    expect(stripTrailingPunctuation("อาหารฯลฯ")).toBe("อาหารฯลฯ");
    expect(stripTrailingPunctuation("ฯลฯ.")).toBe("ฯลฯ");
    expect(stripTrailingPunctuation("กรุงเทพฯ?")).toBe("กรุงเทพฯ");
  });
});
