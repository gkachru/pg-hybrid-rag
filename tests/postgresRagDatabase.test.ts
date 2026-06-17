import { describe, expect, it } from "bun:test";
import { PostgresRagDatabase } from "../src/adapters/PostgresRagDatabase.js";
import type { FtsContext, FtsStrategy, SqlClient, TransactionProvider } from "../src/interfaces.js";
import type { HybridSearchParams } from "../src/types.js";

function recordingTx() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    query: async <T>(sql: string, params: unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      return [] as T[];
    },
  };
  const txProvider: TransactionProvider = {
    withConnection: async <T>(fn: (c: SqlClient) => Promise<T>) => fn(client),
  };
  return { txProvider, calls };
}

const params: HybridSearchParams = {
  tenantId: "t1",
  embeddingStr: "[0.1,0.2]",
  query: "phones",
  synonymLookup: new Map(),
  language: "en",
  candidateLimit: 10,
  vectorMinScore: 0.8,
  keywordMinScore: 0.35,
};

describe("PostgresRagDatabase.hybridSearch", () => {
  it("runs the vector leg with the cosine operator", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    expect(calls.some((c) => c.sql.includes("embedding <=> $2::vector"))).toBe(true);
  });

  it("runs the keyword leg with word_similarity by default", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    expect(calls.some((c) => c.sql.includes("word_similarity($2, content)"))).toBe(true);
  });

  it("selects the chunk id in the vector and keyword legs (for RRF dedup)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    const vectorLeg = calls.find((c) => c.sql.includes("embedding <=> $2::vector"));
    const keywordLeg = calls.find((c) => c.sql.includes("word_similarity($2, content)"));
    expect(vectorLeg?.sql).toContain("SELECT id, content");
    expect(keywordLeg?.sql).toContain("SELECT id, content");
  });

  it("uses bigm_similarity for CJK when cjk: true", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { cjk: true }).hybridSearch({
      ...params,
      language: "ja",
    });
    expect(calls.some((c) => c.sql.includes("bigm_similarity($2, content)"))).toBe(true);
  });

  it("delegates the FTS leg to the injected strategy with a mapped context", async () => {
    const { txProvider } = recordingTx();
    let seen: FtsContext | undefined;
    const spyFts: FtsStrategy = {
      search: async (_client, ctx) => {
        seen = ctx;
        return [];
      },
    };
    await new PostgresRagDatabase(txProvider, { fts: spyFts }).hybridSearch(params);
    expect(seen?.tenantId).toBe("t1");
    expect(seen?.query).toBe("phones");
    expect(seen?.synonyms).toBeInstanceOf(Map);
    expect(seen?.language).toBe("en");
    expect(seen?.candidateLimit).toBe(10);
  });

  it("defaults to TsvectorFts (emits tsquery SQL) when no fts option is given", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    expect(calls.some((c) => c.sql.includes("plainto_tsquery(rag_fts_config($4), $2)"))).toBe(true);
  });
});
