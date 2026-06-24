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

  it("detects supplementary-plane Han (CJK Extension B) as Chinese", () => {
    // U+20000+ is astral CJK. charCodeAt(0) reads only the high surrogate and
    // matches no range (falls through to "en"); codePointAt(0) reads the whole
    // code point so this rare Han is detected.
    expect(detectLanguage("𠀀𠀁𠀂")).toBe("zh");
  });

  it("defaults to English for empty input", () => {
    expect(detectLanguage("")).toBe("en");
  });

  it("detects Arabic when Arabic dominates a stray Han char", () => {
    expect(detectLanguage("أحذية الجري مريحة 中")).toBe("ar");
  });

  it("detects Hindi when Devanagari dominates a stray Han char", () => {
    expect(detectLanguage("दौड़ते हुए जूते 中")).toBe("hi");
  });

  it("does not call a lone Han char Chinese when it is far below half the script", () => {
    // Han with little/no Latin but a dominant non-Latin script: the comment says
    // Han wins only when it carries at least half the script, so this must be "ar".
    expect(detectLanguage("السلام عليكم 中")).toBe("ar");
  });

  it("detects Thai from Thai script", () => {
    expect(detectLanguage("ผมอยากเปลี่ยนแพ็กเกจ")).toBe("th");
  });

  it("detects Thai when Thai dominates mixed Latin", () => {
    expect(detectLanguage("อินเทอร์เน็ต 5g")).toBe("th");
  });
});
