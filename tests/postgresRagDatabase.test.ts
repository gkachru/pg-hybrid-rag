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

  // --- Finding #1: keyword leg must use index-friendly trigram operator ---

  it("keyword leg uses the index-friendly word-similarity operator ($2 <% content)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    const keywordLeg = calls.find((c) => c.sql.includes("word_similarity($2, content)"));
    // The WHERE clause drives the GIN index via the operator, not a bare function comparison.
    expect(keywordLeg?.sql).toContain("$2 <% content");
    expect(keywordLeg?.sql).not.toContain("word_similarity($2, content) >");
    // word_similarity stays in SELECT and ORDER BY for the score.
    expect(keywordLeg?.sql).toContain("word_similarity($2, content) as score");
    expect(keywordLeg?.sql).toContain("ORDER BY word_similarity($2, content) DESC");
  });

  it("keyword leg sets the trigram word-similarity threshold transaction-locally", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    // Threshold applied via set_config(..., true) so it survives only inside the leg txn,
    // and is parameterized (SET LOCAL cannot take a bind parameter).
    const setCall = calls.find(
      (c) => typeof c.sql === "string" && c.sql.includes("pg_trgm.word_similarity_threshold"),
    );
    expect(setCall).toBeDefined();
    expect(setCall?.sql).toContain("set_config('pg_trgm.word_similarity_threshold'");
    expect(setCall?.sql).toContain("true");
    expect(setCall?.params).toContain(String(params.keywordMinScore));
    // The set_config runs inside an explicit transaction.
    expect(calls.some((c) => c.sql === "BEGIN")).toBe(true);
    expect(calls.some((c) => c.sql === "COMMIT")).toBe(true);
  });

  it("CJK keyword leg uses the bigm =% operator and pg_bigm.similarity_limit", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { cjk: true }).hybridSearch({
      ...params,
      language: "ja",
    });
    const keywordLeg = calls.find((c) => c.sql.includes("bigm_similarity($2, content)"));
    expect(keywordLeg?.sql).toContain("content =% $2");
    expect(keywordLeg?.sql).not.toContain("bigm_similarity($2, content) >");
    const setCall = calls.find(
      (c) => typeof c.sql === "string" && c.sql.includes("pg_bigm.similarity_limit"),
    );
    expect(setCall?.sql).toContain("set_config('pg_bigm.similarity_limit'");
  });

  // --- Finding #10: vector leg must set ivfflat.probes ---

  it("vector leg sets ivfflat.probes transaction-locally with the default", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    const setCall = calls.find(
      (c) => typeof c.sql === "string" && c.sql.includes("ivfflat.probes"),
    );
    expect(setCall).toBeDefined();
    expect(setCall?.sql).toContain("set_config('ivfflat.probes'");
    expect(setCall?.sql).toContain("true");
    expect(setCall?.params).toContain("10");
  });

  it("vector leg honors a custom ivfflatProbes option", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { ivfflatProbes: 25 }).hybridSearch(params);
    const setCall = calls.find(
      (c) => typeof c.sql === "string" && c.sql.includes("ivfflat.probes"),
    );
    expect(setCall?.params).toContain("25");
  });
});
