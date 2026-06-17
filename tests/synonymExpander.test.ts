import { describe, expect, it } from "bun:test";
import { buildBm25Query, buildFtsQuery, expandQueryWithSynonyms } from "../src/synonymExpander.js";
import type { SynonymLookup } from "../src/types.js";

function makeLookup(
  entries: Array<{ lang: string; term: string; expansions: string[] }>,
): SynonymLookup {
  const lookup: SynonymLookup = new Map();
  for (const { lang, term, expansions } of entries) {
    if (!lookup.has(lang)) lookup.set(lang, new Map());
    lookup.get(lang)?.set(term, expansions);
  }
  return lookup;
}

describe("expandQueryWithSynonyms", () => {
  it("expands a term with its synonyms", () => {
    const lookup = makeLookup([{ lang: "en", term: "phones", expansions: ["smartphones"] }]);
    expect(expandQueryWithSynonyms("best phones market", lookup)).toBe(
      "best phones smartphones market",
    );
  });

  it("does not expand when no synonyms match", () => {
    const lookup = makeLookup([{ lang: "en", term: "tv", expansions: ["television"] }]);
    expect(expandQueryWithSynonyms("best phones market", lookup)).toBe("best phones market");
  });

  it("returns original query when lookup is empty", () => {
    const lookup: SynonymLookup = new Map();
    expect(expandQueryWithSynonyms("best phones market", lookup)).toBe("best phones market");
  });

  it("deduplicates expansion terms", () => {
    const lookup = makeLookup([
      { lang: "en", term: "phones", expansions: ["smartphones", "market"] },
    ]);
    expect(expandQueryWithSynonyms("best phones market", lookup)).toBe(
      "best phones smartphones market",
    );
  });

  it("is case-insensitive on lookup", () => {
    const lookup = makeLookup([{ lang: "en", term: "phones", expansions: ["smartphones"] }]);
    expect(expandQueryWithSynonyms("best Phones market", lookup)).toBe(
      "best Phones smartphones market",
    );
  });

  it("merges synonyms across languages", () => {
    const lookup = makeLookup([
      { lang: "en", term: "mobile", expansions: ["cellphone"] },
      { lang: "hi", term: "mobile", expansions: ["phone"] },
    ]);
    expect(expandQueryWithSynonyms("best mobile", lookup)).toBe("best mobile cellphone phone");
  });

  it("caps at 5 expansions per term from merged languages", () => {
    const lookup = makeLookup([
      { lang: "en", term: "tv", expansions: ["television", "telly", "monitor"] },
      { lang: "hi", term: "tv", expansions: ["televizion", "screen", "display", "panel"] },
    ]);
    const result = expandQueryWithSynonyms("tv", lookup);
    const words = result.split(" ");
    expect(words.length).toBeLessThanOrEqual(6);
    expect(words[0]).toBe("tv");
  });

  it("handles multiple expandable terms", () => {
    const lookup = makeLookup([
      { lang: "en", term: "phones", expansions: ["smartphones"] },
      { lang: "en", term: "tv", expansions: ["television"] },
    ]);
    expect(expandQueryWithSynonyms("phones and tv", lookup)).toBe(
      "phones smartphones and tv television",
    );
  });

  it("matches multi-word synonym keys", () => {
    const lookup = makeLookup([{ lang: "en", term: "cash on delivery", expansions: ["cod"] }]);
    expect(expandQueryWithSynonyms("I want cash on delivery", lookup)).toBe(
      "I want cash on delivery cod",
    );
  });

  it("prefers longest match for multi-word keys", () => {
    const lookup = makeLookup([
      { lang: "en", term: "cash", expansions: ["money"] },
      { lang: "en", term: "cash on delivery", expansions: ["cod"] },
    ]);
    expect(expandQueryWithSynonyms("cash on delivery please", lookup)).toBe(
      "cash on delivery cod please",
    );
  });

  it("two-way synonym expands both directions", () => {
    const lookup = makeLookup([
      { lang: "en", term: "cod", expansions: ["cash on delivery"] },
      { lang: "en", term: "cash on delivery", expansions: ["cod"] },
    ]);
    expect(expandQueryWithSynonyms("I want cod", lookup)).toBe("I want cod cash on delivery");
    expect(expandQueryWithSynonyms("I want cash on delivery", lookup)).toBe(
      "I want cash on delivery cod",
    );
  });

  it("preserves a repeated query word so BM25 term frequency is honored", () => {
    // A legitimately repeated query word must survive (the BM25 leg ranks on
    // term frequency). The synonym expansion is still de-duped across the query.
    const lookup = makeLookup([{ lang: "en", term: "tv", expansions: ["television"] }]);
    expect(expandQueryWithSynonyms("buy tv tv", lookup)).toBe("buy tv television tv");
  });
});

describe("buildFtsQuery", () => {
  it("builds OR groups for synonyms", () => {
    const lookup = makeLookup([{ lang: "en", term: "phones", expansions: ["smartphones"] }]);
    expect(buildFtsQuery("best phones market", lookup)).toBe(
      "best & (phones | smartphones) & market",
    );
  });

  it("returns plain & join when no synonyms match", () => {
    const lookup = makeLookup([{ lang: "en", term: "tv", expansions: ["television"] }]);
    expect(buildFtsQuery("best phones market", lookup)).toBe("best & phones & market");
  });

  it("returns plain & join when lookup is empty", () => {
    const lookup: SynonymLookup = new Map();
    expect(buildFtsQuery("best phones", lookup)).toBe("best & phones");
  });

  it("sanitizes special characters in terms", () => {
    const lookup: SynonymLookup = new Map();
    expect(buildFtsQuery("best & phones | market", lookup)).toBe("best & phones & market");
  });

  it("sanitizes special characters in synonyms", () => {
    const lookup = makeLookup([{ lang: "en", term: "test", expansions: ["foo|bar", "baz&qux"] }]);
    const result = buildFtsQuery("test", lookup);
    expect(result).toBe("(test | foobar | bazqux)");
  });

  it("skips empty terms after sanitization", () => {
    const lookup: SynonymLookup = new Map();
    expect(buildFtsQuery("| & !", lookup)).toBe("");
  });

  it("converts multi-word synonyms to phrase operator", () => {
    const lookup = makeLookup([
      { lang: "en", term: "smartwatch", expansions: ["apple watch", "galaxy watch"] },
    ]);
    expect(buildFtsQuery("smartwatch", lookup)).toBe(
      "(smartwatch | apple <-> watch | galaxy <-> watch)",
    );
  });

  it("matches multi-word synonym keys", () => {
    const lookup = makeLookup([{ lang: "en", term: "cash on delivery", expansions: ["cod"] }]);
    expect(buildFtsQuery("want cash on delivery", lookup)).toBe(
      "want & (cash <-> on <-> delivery | cod)",
    );
  });

  it("drops an empty phrase when a multi-word key sanitizes to empty", () => {
    // The synonym KEY is made of tsquery-special chars, so every word in the
    // matched span sanitizes to "". The phrase must be dropped, leaving only
    // the expansion — never emitting an invalid group like "( | cod)".
    const lookup = makeLookup([{ lang: "en", term: "& |", expansions: ["cod"] }]);
    expect(buildFtsQuery("& |", lookup)).toBe("cod");
  });

  it("skips a multi-word group entirely when no terms survive sanitization", () => {
    // Both the matched span and its expansions sanitize to empty: the whole
    // group must be skipped rather than emitting a stray empty group.
    const lookup = makeLookup([{ lang: "en", term: "& |", expansions: ["!", "()"] }]);
    expect(buildFtsQuery("& |", lookup)).toBe("");
  });

  it("two-way synonym builds FTS for both directions", () => {
    const lookup = makeLookup([
      { lang: "en", term: "cod", expansions: ["cash on delivery"] },
      { lang: "en", term: "cash on delivery", expansions: ["cod"] },
    ]);
    expect(buildFtsQuery("cod", lookup)).toBe("(cod | cash <-> on <-> delivery)");
    expect(buildFtsQuery("want cash on delivery", lookup)).toBe(
      "want & (cash <-> on <-> delivery | cod)",
    );
  });
});

describe("buildBm25Query", () => {
  it("expands synonyms into a flat space-separated list", () => {
    const lookup = makeLookup([{ lang: "en", term: "phones", expansions: ["smartphones"] }]);
    expect(buildBm25Query("best phones market", lookup)).toBe("best phones smartphones market");
  });

  it("returns the query unchanged when no synonyms match", () => {
    const lookup = makeLookup([{ lang: "en", term: "tv", expansions: ["television"] }]);
    expect(buildBm25Query("best phones market", lookup)).toBe("best phones market");
  });

  it("returns the query unchanged when the lookup is empty", () => {
    expect(buildBm25Query("best phones", new Map())).toBe("best phones");
  });

  it("flattens multi-word synonyms into individual terms", () => {
    const lookup = makeLookup([{ lang: "en", term: "cash on delivery", expansions: ["cod"] }]);
    expect(buildBm25Query("want cash on delivery", lookup)).toBe("want cash on delivery cod");
  });

  it("strips characters special to the query parser", () => {
    expect(buildBm25Query("best & phones | market", new Map())).toBe("best phones market");
  });

  it("drops terms that sanitize to empty", () => {
    expect(buildBm25Query("| & !", new Map())).toBe("");
  });

  it("preserves a repeated query word for term-frequency ranking", () => {
    const lookup = makeLookup([{ lang: "en", term: "iphone", expansions: ["smartphone"] }]);
    expect(buildBm25Query("iphone iphone case", lookup)).toBe("iphone smartphone iphone case");
  });
});
