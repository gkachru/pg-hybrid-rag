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
    expect(calls[0].sql).toContain("-(content <@> $2) as score");
    expect(calls[0].sql).toContain("ORDER BY content <@> $2");
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
