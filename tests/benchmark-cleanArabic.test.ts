import { expect, test } from "bun:test";
import {
  arabicRatio,
  cleanArabicDoc,
  isArabicDominant,
  stripRecurringBoilerplate,
} from "../examples/benchmark/cleanArabic.js";

test("arabicRatio counts Arabic letters over all letters", () => {
  expect(arabicRatio("مرحبا")).toBe(1);
  expect(arabicRatio("hello")).toBe(0);
  expect(arabicRatio("12345 ؟!")).toBe(0); // no letters -> 0
  expect(arabicRatio("ab مرحبا")).toBeCloseTo(5 / 7);
});

test("isArabicDominant honors threshold", () => {
  expect(isArabicDominant("مرحبا hello", 0.4)).toBe(true);
  expect(isArabicDominant("hello world مر", 0.5)).toBe(false);
});

test("stripRecurringBoilerplate drops lines on >= half the pages", () => {
  const pages = ["HEADER\nالسطر الأول", "HEADER\nالسطر الثاني", "HEADER\nالسطر الثالث"];
  const out = stripRecurringBoilerplate(pages);
  expect(out.join("\n").includes("HEADER")).toBe(false);
  expect(out.join("\n").includes("السطر الأول")).toBe(true);
});

test("cleanArabicDoc strips boilerplate and keeps Arabic lines", () => {
  const pages = [
    "Restricted\nمحتوى عربي مفيد\nEnglish only line",
    "Restricted\nسطر عربي آخر\nAnother english line",
  ];
  const out = cleanArabicDoc(pages);
  expect(out.includes("محتوى عربي مفيد")).toBe(true);
  expect(out.includes("سطر عربي آخر")).toBe(true);
  expect(out.includes("Restricted")).toBe(false);
  expect(out.includes("English only line")).toBe(false);
});
