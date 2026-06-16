import { describe, expect, it } from "bun:test";
import { TsvectorFts } from "../src/adapters/fts/TsvectorFts.js";
import type { SqlClient } from "../src/interfaces.js";
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

function capturingClient(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    query: async <T>(sql: string, params: unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      return rows as T[];
    },
  };
  return { client, calls };
}

const base = { tenantId: "t1", language: "en", candidateLimit: 10 };

describe("TsvectorFts", () => {
  it("uses to_tsquery for multi-term / synonym queries and passes the OR-group string", async () => {
    const { client, calls } = capturingClient();
    const synonyms = makeLookup([{ lang: "en", term: "phones", expansions: ["smartphones"] }]);
    await new TsvectorFts().search(client, { ...base, query: "best phones", synonyms });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("to_tsquery(rag_fts_config($4), $2)");
    expect(calls[0].params[1]).toBe("best & (phones | smartphones)");
    expect(calls[0].params[3]).toBe("en");
  });

  it("uses plainto_tsquery with the raw query for single-term no-synonym queries", async () => {
    const { client, calls } = capturingClient();
    await new TsvectorFts().search(client, { ...base, query: "phones", synonyms: new Map() });
    expect(calls[0].sql).toContain("plainto_tsquery(rag_fts_config($4), $2)");
    expect(calls[0].params[1]).toBe("phones");
  });

  it("appends source-type filter at $5", async () => {
    const { client, calls } = capturingClient();
    await new TsvectorFts().search(client, {
      ...base,
      query: "phones",
      synonyms: new Map(),
      sourceTypes: ["faq"],
    });
    expect(calls[0].sql).toContain("source_type = ANY(string_to_array($5::text, ','))");
    expect(calls[0].params[4]).toBe("faq");
  });

  it("maps rows to ranked candidates", async () => {
    const { client } = capturingClient([
      { content: "c", source_type: "faq", source_id: "1", metadata: "{}" },
    ]);
    const res = await new TsvectorFts().search(client, {
      ...base,
      query: "phones",
      synonyms: new Map(),
    });
    expect(res).toEqual([{ content: "c", sourceType: "faq", sourceId: "1", metadata: "{}" }]);
  });
});
