import { describe, expect, it } from "bun:test";
import { Bm25Fts } from "../src/adapters/fts/Bm25Fts.js";
import type { SqlClient } from "../src/interfaces.js";

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

describe("Bm25Fts", () => {
  it("emits the <@> BM25 SQL with negated score and ascending order", async () => {
    const { client, calls } = capturingClient();
    await new Bm25Fts().search(client, { ...base, query: "best phones", synonyms: new Map() });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain(
      "-(content_normalized <@> to_bm25query($2, 'idx_rag_bm25_en')) as score",
    );
    expect(calls[0].sql).toContain(
      "ORDER BY content_normalized <@> to_bm25query($2, 'idx_rag_bm25_en')",
    );
    expect(calls[0].sql).toContain("language IN ('en', 'en-US', 'en-IN')");
    expect(calls[0].params[1]).toBe("best phones");
  });

  it("uses the NOT IN catch-all predicate for unsupported languages", async () => {
    const { client, calls } = capturingClient();
    await new Bm25Fts().search(client, {
      ...base,
      language: "hi",
      query: "x",
      synonyms: new Map(),
    });
    expect(calls[0].sql).toContain("language NOT IN (");
  });

  it("places result filters starting at $4 (no $4 language param for BM25)", async () => {
    const { client, calls } = capturingClient();
    await new Bm25Fts().search(client, {
      ...base,
      query: "x",
      synonyms: new Map(),
      sourceTypes: ["faq"],
    });
    expect(calls[0].sql).toContain("source_type = ANY(string_to_array($4::text, ','))");
    expect(calls[0].params[3]).toBe("faq");
  });

  it("orders all three filters after the base params (sourceTypes $4, sourceIds $5, languages $6)", async () => {
    const { client, calls } = capturingClient();
    await new Bm25Fts().search(client, {
      ...base,
      query: "phones",
      synonyms: new Map(),
      sourceTypes: ["faq"],
      sourceIds: ["s1"],
      languages: ["en"],
    });
    expect(calls[0].sql).toContain("source_type = ANY(string_to_array($4::text, ','))");
    expect(calls[0].sql).toContain("source_id::text = ANY(string_to_array($5::text, ','))");
    expect(calls[0].sql).toContain("language = ANY(string_to_array($6::text, ','))");
    // base params $1..$3, then the three filters in order
    expect(calls[0].params).toEqual(["t1", "phones", 10, "faq", "s1", "en"]);
    // the stemming-config predicate (from ctx.language) is independent of the languages filter
    expect(calls[0].sql).toContain("language IN ('en', 'en-US', 'en-IN')");
  });

  it("drops zero-score padding rows so only genuine lexical matches reach RRF", async () => {
    // pg_textsearch's `<@>` returns 0 for docs containing none of the query terms, and a
    // positive (negated-distance) score for real matches. A bare `ORDER BY <@> LIMIT k` pads
    // the result up to k with those zero-score non-matches. RRF fuses by rank, so the padding
    // would inject spurious positive signal — drop it here, matching TsvectorFts's `@@` gate.
    const rows = [
      {
        id: "a",
        content: "real match",
        source_type: "doc",
        source_id: "1",
        metadata: "{}",
        score: 0.92,
      },
      { id: "b", content: "padding", source_type: "doc", source_id: "2", metadata: "{}", score: 0 },
      { id: "c", content: "padding", source_type: "doc", source_id: "3", metadata: "{}", score: 0 },
    ];
    const { client } = capturingClient(rows);
    const res = await new Bm25Fts().search(client, {
      ...base,
      query: "match",
      synonyms: new Map(),
    });
    expect(res.map((r) => r.id)).toEqual(["a"]);
  });

  it("returns [] without querying when the query sanitizes to empty", async () => {
    const { client, calls } = capturingClient();
    const res = await new Bm25Fts().search(client, {
      ...base,
      query: "| & !",
      synonyms: new Map(),
    });
    expect(res).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
