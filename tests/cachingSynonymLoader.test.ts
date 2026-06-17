import { describe, expect, it } from "bun:test";
import { CachingSynonymLoader } from "../src/adapters/CachingSynonymLoader.js";
import type { SqlClient, TransactionProvider } from "../src/interfaces.js";
import type { SynonymRow } from "../src/types.js";

/** Build a loader whose loadFn returns the given rows (no real DB). */
function loaderFor(rows: SynonymRow[]) {
  const txProvider: TransactionProvider = {
    withConnection: async (fn) => fn({} as SqlClient),
  };
  return new CachingSynonymLoader({ txProvider, loadFn: async () => rows });
}

describe("CachingSynonymLoader", () => {
  it("builds a forward mapping from a string-array synonyms column", async () => {
    const loader = loaderFor([
      { language: "en", term: "phone", synonyms: ["mobile", "cell"], direction: "one_way" },
    ]);
    const lookup = await loader.load("t1");
    expect(lookup.get("en")?.get("phone")).toEqual(["mobile", "cell"]);
  });

  it("parses a JSON-string synonyms column (driver-dependent JSONB)", async () => {
    const loader = loaderFor([
      {
        language: "en",
        term: "phone",
        synonyms: '["mobile","cell"]' as unknown as string[],
        direction: "one_way",
      },
    ]);
    const lookup = await loader.load("t1");
    expect(lookup.get("en")?.get("phone")).toEqual(["mobile", "cell"]);
  });

  it("lowercases terms and synonyms", async () => {
    const loader = loaderFor([
      { language: "en", term: "Phone", synonyms: ["Mobile", "CELL"], direction: "one_way" },
    ]);
    const lookup = await loader.load("t1");
    expect(lookup.get("en")?.get("phone")).toEqual(["mobile", "cell"]);
  });

  it("adds reverse mappings for two_way direction", async () => {
    const loader = loaderFor([
      { language: "en", term: "phone", synonyms: ["mobile"], direction: "two_way" },
    ]);
    const lookup = await loader.load("t1");
    expect(lookup.get("en")?.get("phone")).toEqual(["mobile"]);
    expect(lookup.get("en")?.get("mobile")).toEqual(["phone"]);
  });

  it("does not add reverse mappings for one_way direction", async () => {
    const loader = loaderFor([
      { language: "en", term: "phone", synonyms: ["mobile"], direction: "one_way" },
    ]);
    const lookup = await loader.load("t1");
    expect(lookup.get("en")?.get("mobile")).toBeUndefined();
  });

  it("caps the number of synonyms per term", async () => {
    const loader = loaderFor([
      {
        language: "en",
        term: "phone",
        synonyms: ["a", "b", "c", "d", "e", "f", "g"],
        direction: "one_way",
      },
    ]);
    const lookup = await loader.load("t1");
    expect(lookup.get("en")?.get("phone")?.length).toBe(5);
  });

  describe("malformed-row guarding (#4)", () => {
    it("skips a row whose JSON string is unparseable without failing the tenant", async () => {
      const loader = loaderFor([
        {
          language: "en",
          term: "broken",
          synonyms: "}{not json" as unknown as string[],
          direction: "one_way",
        },
        { language: "en", term: "phone", synonyms: ["mobile"], direction: "one_way" },
      ]);
      const lookup = await loader.load("t1");
      // Good row still mapped; bad row skipped.
      expect(lookup.get("en")?.get("phone")).toEqual(["mobile"]);
      expect(lookup.get("en")?.get("broken")).toBeUndefined();
    });

    it("skips a row whose parsed synonyms is not an array", async () => {
      const loader = loaderFor([
        {
          language: "en",
          term: "obj",
          synonyms: '{"not":"an array"}' as unknown as string[],
          direction: "one_way",
        },
        { language: "en", term: "phone", synonyms: ["mobile"], direction: "one_way" },
      ]);
      const lookup = await loader.load("t1");
      expect(lookup.get("en")?.get("obj")).toBeUndefined();
      expect(lookup.get("en")?.get("phone")).toEqual(["mobile"]);
    });

    it("treats a null synonyms value as a skipped row", async () => {
      const loader = loaderFor([
        {
          language: "en",
          term: "nullsyn",
          synonyms: null as unknown as string[],
          direction: "one_way",
        },
        { language: "en", term: "phone", synonyms: ["mobile"], direction: "one_way" },
      ]);
      const lookup = await loader.load("t1");
      expect(lookup.get("en")?.get("nullsyn")).toBeUndefined();
      expect(lookup.get("en")?.get("phone")).toEqual(["mobile"]);
    });

    it("filters non-string elements from a mixed array rather than throwing", async () => {
      const loader = loaderFor([
        {
          language: "en",
          term: "phone",
          synonyms: ["mobile", 3, null, "cell"] as unknown as string[],
          direction: "one_way",
        },
      ]);
      const lookup = await loader.load("t1");
      expect(lookup.get("en")?.get("phone")).toEqual(["mobile", "cell"]);
    });
  });

  describe("caching", () => {
    it("does not re-run loadFn within the TTL window", async () => {
      let calls = 0;
      const txProvider: TransactionProvider = {
        withConnection: async (fn) => fn({} as SqlClient),
      };
      const loader = new CachingSynonymLoader({
        txProvider,
        loadFn: async () => {
          calls++;
          return [{ language: "en", term: "phone", synonyms: ["mobile"], direction: "one_way" }];
        },
      });
      await loader.load("t1");
      await loader.load("t1");
      expect(calls).toBe(1);
    });

    it("re-runs loadFn after invalidate", async () => {
      let calls = 0;
      const txProvider: TransactionProvider = {
        withConnection: async (fn) => fn({} as SqlClient),
      };
      const loader = new CachingSynonymLoader({
        txProvider,
        loadFn: async () => {
          calls++;
          return [{ language: "en", term: "phone", synonyms: ["mobile"], direction: "one_way" }];
        },
      });
      await loader.load("t1");
      loader.invalidate("t1");
      await loader.load("t1");
      expect(calls).toBe(2);
    });
  });
});
