import { expect, test } from "bun:test";
import { withEmbeddingCache } from "../examples/benchmark/embeddingCache.js";

test("embedDocuments embeds each unique text once, preserves order", async () => {
  const calls: string[][] = [];
  const inner = {
    embedQuery: async (t: string) => [t.length],
    embedDocuments: async (texts: string[]) => {
      calls.push(texts);
      return texts.map((t) => [t.length]);
    },
  };
  const cached = withEmbeddingCache(inner);

  const r1 = await cached.embedDocuments(["aa", "bbb", "aa"]);
  expect(r1).toEqual([[2], [3], [2]]);
  expect(calls).toEqual([["aa", "bbb"]]); // "aa" embedded once, deduped

  const r2 = await cached.embedDocuments(["bbb", "cccc"]);
  expect(r2).toEqual([[3], [4]]);
  expect(calls).toEqual([["aa", "bbb"], ["cccc"]]); // only the new text

  // embedQuery hits the same cache
  calls.length = 0;
  expect(await cached.embedQuery("aa")).toEqual([2]);
  expect(calls).toEqual([]); // served from cache, no inner call
});
