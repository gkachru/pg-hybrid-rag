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

/** The distinct positional placeholders ($1, $2, …) referenced in a SQL string. */
function referencedPlaceholders(sql: string): Set<number> {
  const refs = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) refs.add(Number(m[1]));
  return refs;
}

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

  // --- Every bound parameter must be referenced by the SQL ---
  // Regression: the keyword leg bound keywordMinScore as an unreferenced $3 (its threshold
  // moved into a GUC), so Postgres rejected the statement at runtime with "could not determine
  // data type of parameter $3" — invisible to string-only assertions and to the mocked legs.
  // Guard that every leg references exactly the placeholders it binds: {1..params.length}.

  function assertEveryParamReferenced(calls: Array<{ sql: string; params: unknown[] }>) {
    for (const { sql, params: p } of calls) {
      const refs = referencedPlaceholders(sql);
      for (let n = 1; n <= p.length; n++) {
        expect(refs.has(n)).toBe(true); // bound $n must appear in the SQL
      }
      for (const ref of refs) {
        expect(ref).toBeLessThanOrEqual(p.length); // no $n beyond the bound params
      }
    }
  }

  it("binds no unreferenced parameter in any leg (no filters)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    assertEveryParamReferenced(calls);
  });

  it("binds no unreferenced parameter in any leg (with filters)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch({
      ...params,
      sourceTypes: ["faq", "product"],
      languages: ["en", "hi"],
    });
    assertEveryParamReferenced(calls);
  });

  it("binds no unreferenced parameter in the CJK keyword leg", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { cjk: true }).hybridSearch({
      ...params,
      language: "ja",
    });
    assertEveryParamReferenced(calls);
  });
});

// --- A failing leg fails the whole search, but only AFTER every leg settles ---
// Fail-fast is intentional (no partial results), but Promise.all rejected the instant one
// leg failed — abandoning the sibling legs mid-query on their reserved connections, which
// makes a consumer's connection cleanup hang. Promise.allSettled waits for every leg to
// settle first (so nothing is abandoned), then raises.

describe("PostgresRagDatabase.hybridSearch leg-failure handling", () => {
  /**
   * A provider whose keyword leg's main SELECT throws, while the vector and FTS legs'
   * main SELECTs resolve only after a macrotask — so they are still in flight at the
   * instant the keyword leg rejects. `released` counts completed withConnection callbacks.
   */
  function failingKeywordTx(slowMs: number) {
    let released = 0;
    const slow = () => new Promise<void>((r) => setTimeout(r, slowMs));
    const client: SqlClient = {
      query: async <T>(sql: string): Promise<T[]> => {
        if (sql.includes("word_similarity($2, content) as score")) {
          throw new Error("keyword leg boom");
        }
        if (sql.includes("embedding <=> $2::vector") || sql.includes("tsquery(")) {
          await slow(); // vector / FTS legs stay in flight past the keyword rejection
        }
        return [] as T[];
      },
    };
    const txProvider: TransactionProvider = {
      withConnection: async <T>(fn: (c: SqlClient) => Promise<T>) => {
        try {
          return await fn(client);
        } finally {
          released++;
        }
      },
    };
    return { txProvider, releasedCount: () => released };
  }

  it("raises an error when a leg fails (no partial results)", async () => {
    const { txProvider } = failingKeywordTx(0);
    await expect(new PostgresRagDatabase(txProvider).hybridSearch(params)).rejects.toThrow(
      /keyword/,
    );
  });

  it("awaits every leg before raising (does not abandon in-flight legs)", async () => {
    const { txProvider, releasedCount } = failingKeywordTx(20);
    const err = await new PostgresRagDatabase(txProvider).hybridSearch(params).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // All three legs' withConnection callbacks completed before the error surfaced.
    // Promise.all would have rejected with the slow vector/FTS legs still in flight (released < 3).
    expect(releasedCount()).toBe(3);
  });
});
