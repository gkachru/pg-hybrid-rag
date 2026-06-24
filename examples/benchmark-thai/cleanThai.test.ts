import { describe, expect, test } from "bun:test";
import { cleanThaiDoc, isThaiDominant, stripRecurringBoilerplate, thaiRatio } from "./cleanThai";

describe("cleanThai", () => {
  test("thaiRatio: pure Thai = 1", () => {
    expect(thaiRatio("นโยบาย")).toBe(1);
  });
  test("isThaiDominant: Thai line with a brand token stays dominant", () => {
    expect(isThaiDominant("เปิดบริการโรมมิ่ง 5G ระหว่างประเทศ")).toBe(true);
  });
  test("isThaiDominant: mostly-Latin line is not dominant", () => {
    expect(isThaiDominant("Terms and Conditions apply ก")).toBe(false);
  });
  test("thaiRatio: digits are not letters", () => {
    expect(thaiRatio("12345")).toBe(0);
  });
  test("stripRecurringBoilerplate drops lines recurring on >= half the pages", () => {
    const pages = ["HEADER\nเนื้อหา ก", "HEADER\nเนื้อหา ข", "HEADER\nเนื้อหา ค"];
    const out = stripRecurringBoilerplate(pages);
    expect(out.join("\n")).not.toContain("HEADER");
    expect(out.join("\n")).toContain("เนื้อหา");
  });
  test("cleanThaiDoc keeps Thai-dominant lines, drops Latin boilerplate", () => {
    const doc = cleanThaiDoc(["Copyright 2026\nนโยบายความเป็นส่วนตัว", "Copyright 2026\nการคืนเงิน"]);
    expect(doc).toContain("นโยบาย");
    expect(doc).not.toContain("Copyright");
  });
});
