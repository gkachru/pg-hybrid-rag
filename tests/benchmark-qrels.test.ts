import { expect, test } from "bun:test";
import { resolveQueries, snippetPresent } from "../examples/benchmark/qrels.js";
import type { BenchmarkQuery } from "../examples/benchmark/types.js";

const q = (id: string, target: string): BenchmarkQuery => ({
  id,
  domain: "banking",
  provider: "p",
  target_doc: target,
  target_snippet: "x",
  variants: { msa: "m", saudi: "s", darija: "d" },
});

test("resolveQueries partitions on target_doc membership", () => {
  const corpus = new Set(["faq:p:1", "faq:p:2"]);
  const { resolved, unresolved } = resolveQueries([q("a", "faq:p:1"), q("b", "faq:p:9")], corpus);
  expect(resolved.map((x) => x.id)).toEqual(["a"]);
  expect(unresolved.map((x) => x.id)).toEqual(["b"]);
});

test("snippetPresent uses the provided normalizer", () => {
  const upper = (s: string) => s.toUpperCase();
  expect(snippetPresent("abc", "xx abc yy", upper)).toBe(true);
  expect(snippetPresent("zzz", "xx abc yy", upper)).toBe(false);
});
