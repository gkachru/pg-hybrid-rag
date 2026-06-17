import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { CachingStopWordsLoader } from "../src/adapters/CachingStopWordsLoader.js";
import type { SqlClient, TransactionProvider } from "../src/interfaces.js";
import type { StopWordRow } from "../src/types.js";

describe("CachingStopWordsLoader.loadMerged", () => {
  afterEach(() => {
    setSystemTime(); // restore the real clock
  });

  it("shares load()'s TTL so the merged set never lags the per-language cache", async () => {
    let dataset: StopWordRow[] = [{ language: "en", word: "the" }];
    const txProvider: TransactionProvider = {
      withConnection: async (fn) => fn({} as SqlClient),
    };
    const loader = new CachingStopWordsLoader({ txProvider, loadFn: async () => dataset });

    // Non-zero base — Bun treats setSystemTime(new Date(0)) as a clock reset.
    const t0 = 1_000_000_000;

    // Prime load()'s cache.
    setSystemTime(new Date(t0));
    await loader.load("t1");

    // +25s: within load()'s 30s TTL, so loadMerged builds from the cached map.
    // With the bug it stamps an INDEPENDENT merged cache at this moment.
    setSystemTime(new Date(t0 + 25_000));
    expect([...(await loader.loadMerged("t1"))]).toEqual(["the"]);

    // Underlying data changes; +35s expires load()'s cache (>30s from t0) but
    // not a 10s-old independent merged cache. The merged set must follow load().
    dataset = [{ language: "en", word: "and" }];
    setSystemTime(new Date(t0 + 35_000));
    expect([...(await loader.loadMerged("t1"))]).toEqual(["and"]);
  });
});
