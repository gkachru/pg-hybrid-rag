import { describe, expect, it } from "bun:test";
import { detectLanguage } from "../src/language.js";

describe("detectLanguage", () => {
  it("detects English", () => {
    expect(detectLanguage("show me watches")).toBe("en");
  });

  it("detects Hindi", () => {
    expect(detectLanguage("दौड़ते हुए जूते")).toBe("hi");
  });

  it("detects Arabic", () => {
    expect(detectLanguage("أحذية الجري مريحة")).toBe("ar");
  });

  it("detects Hinglish for mixed Devanagari + Latin", () => {
    expect(detectLanguage("मुझे running shoes चाहिए")).toBe("hinglish");
  });

  it("detects Chinese from Han characters", () => {
    expect(detectLanguage("数字身份系统")).toBe("zh");
  });

  it("detects Japanese from kana", () => {
    expect(detectLanguage("こんにちは世界")).toBe("ja");
  });

  it("detects Korean from Hangul", () => {
    expect(detectLanguage("안녕하세요 세계")).toBe("ko");
  });

  it("detects Chinese when Han dominates mixed Latin", () => {
    expect(detectLanguage("数字身份 API")).toBe("zh");
  });

  it("detects Japanese from kana even alongside Latin", () => {
    expect(detectLanguage("Reactでアプリを作る")).toBe("ja");
  });

  it("detects Korean from Hangul even alongside Latin", () => {
    expect(detectLanguage("React로 앱 만들기")).toBe("ko");
  });

  it("defaults to English for empty input", () => {
    expect(detectLanguage("")).toBe("en");
  });
});
