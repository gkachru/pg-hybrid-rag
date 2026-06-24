import { describe, expect, test } from "bun:test";
import { isLoanwordHeavy } from "./loanword";

describe("isLoanwordHeavy", () => {
  test("Latin-script run (code-switch / brand) → true", () => {
    expect(isLoanwordHeavy("เปิด international roaming ยังไง")).toBe(true);
  });
  test("brand with adjacent digit (5G) → true", () => {
    expect(isLoanwordHeavy("สมัครเน็ต 5G ยังไง")).toBe(true);
  });
  test("Thai-script transliteration → true", () => {
    expect(isLoanwordHeavy("เปิดโรมมิ่งต่างประเทศยังไง")).toBe(true);
  });
  test("pure native Thai → false", () => {
    expect(isLoanwordHeavy("จะเปิดใช้บริการข้ามแดนได้อย่างไร")).toBe(false);
  });
  test("single stray Latin letter is not a run → false", () => {
    expect(isLoanwordHeavy("ค่าบริการ A")).toBe(false);
  });
});
