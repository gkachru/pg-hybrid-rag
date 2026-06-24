import { describe, expect, test } from "bun:test";
import { resolveQueries, snippetPresent } from "./qrels.js";
import type { BenchmarkQuery } from "./types.js";

const q = (id: string, target: string): BenchmarkQuery => ({
  id,
  domain: "telecom",
  provider: "ais",
  target_doc: target,
  target_snippet: "x",
  variants: { written: "ก", spoken: "ก", codeswitch: "ก" },
});

describe("qrels", () => {
  test("resolveQueries partitions by corpus membership", () => {
    const { resolved, unresolved } = resolveQueries(
      [q("a", "faq:ais:1"), q("b", "faq:x:9")],
      new Set(["faq:ais:1"]),
    );
    expect(resolved.map((r) => r.id)).toEqual(["a"]);
    expect(unresolved.map((r) => r.id)).toEqual(["b"]);
  });
  test("snippetPresent applies the normalizer to both sides", () => {
    expect(snippetPresent("ABC", "xx abc yy", (s) => s.toLowerCase())).toBe(true);
    expect(snippetPresent("zzz", "abc", (s) => s)).toBe(false);
  });
});
