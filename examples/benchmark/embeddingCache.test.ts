import { describe, expect, it } from "bun:test";
import { serialized, withEmbeddingCache } from "./embeddingCache.js";

/** Records how many calls are in flight at once; each call resolves after a short delay. */
function tracker() {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: string[][] = [];
  const fn = async (texts: string[]): Promise<number[][]> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(texts);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return texts.map((t) => [t.length]);
  };
  return { fn, calls, max: () => maxInFlight };
}

describe("serialized", () => {
  it("runs one call at a time, in call order", async () => {
    const t = tracker();
    const run = serialized(t.fn);
    const out = await Promise.all([run(["a"]), run(["bb"]), run(["ccc"])]);
    expect(t.max()).toBe(1);
    expect(t.calls).toEqual([["a"], ["bb"], ["ccc"]]);
    expect(out).toEqual([[[1]], [[2]], [[3]]]);
  });

  it("keeps going after a failed call", async () => {
    let n = 0;
    const run = serialized(async () => {
      n++;
      if (n === 1) throw new Error("boom");
      return n;
    });
    const [a, b] = await Promise.allSettled([run(), run()]);
    expect(a.status).toBe("rejected");
    expect(b).toEqual({ status: "fulfilled", value: 2 });
  });
});

describe("withEmbeddingCache", () => {
  it("sends concurrent queries to the embedder one request at a time", async () => {
    const t = tracker();
    const embedder = withEmbeddingCache({
      embedQuery: async (q) => (await t.fn([q]))[0],
      embedDocuments: t.fn,
    });
    await Promise.all(["q1", "q22", "q333", "q4444"].map((q) => embedder.embedQuery(q)));
    expect(t.max()).toBe(1);
    expect(t.calls).toEqual([["q1"], ["q22"], ["q333"], ["q4444"]]);
  });
});
