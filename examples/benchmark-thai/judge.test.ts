import { describe, expect, test } from "bun:test";
import { parseJudgeScores } from "./judge";

describe("parseJudgeScores", () => {
  test("extracts 0/1/2 in order and pads to n", () => {
    expect(parseJudgeScores("2, 0, 1", 4)).toEqual([2, 0, 1, 0]);
  });
  test("truncates to n", () => {
    expect(parseJudgeScores("1 1 1 1 1", 2)).toEqual([1, 1]);
  });
  test("ignores surrounding Thai text", () => {
    expect(parseJudgeScores("คะแนน: 2 และ 1", 2)).toEqual([2, 1]);
  });
});
