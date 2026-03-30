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

  it("defaults to English for empty input", () => {
    expect(detectLanguage("")).toBe("en");
  });
});
