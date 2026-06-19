import { expect, test } from "bun:test";
import { parseJudgeScores } from "../examples/benchmark/judge.js";

test("parseJudgeScores extracts n leading 0/1/2 ratings", () => {
  expect(parseJudgeScores("2, 0, 1", 3)).toEqual([2, 0, 1]);
  expect(parseJudgeScores("scores: 1 1 2 0", 4)).toEqual([1, 1, 2, 0]);
  expect(parseJudgeScores("nonsense", 2)).toEqual([0, 0]); // miss -> zeros
  expect(parseJudgeScores("2 1", 3)).toEqual([2, 1, 0]); // pad short
});
