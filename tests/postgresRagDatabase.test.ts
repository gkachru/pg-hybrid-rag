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
    expect(calls.some((c) => c.sql.includes("word_similarity($2, content_normalized)"))).toBe(true);
  });

  it("selects the chunk id in the vector and keyword legs (for RRF dedup)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    const vectorLeg = calls.find((c) => c.sql.includes("embedding <=> $2::vector"));
    const keywordLeg = calls.find((c) => c.sql.includes("word_similarity($2, content_normalized)"));
    expect(vectorLeg?.sql).toContain("SELECT id, content");
    expect(keywordLeg?.sql).toContain("SELECT id, content");
  });

  it("scores the CJK keyword leg by query-bigram coverage (show_bigm), not bigm_similarity", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { cjk: true }).hybridSearch({
      ...params,
      language: "ja",
    });
    const keywordLeg = calls.find((c) => c.sql.includes("show_bigm(content)"));
    expect(keywordLeg).toBeDefined();
    // Coverage = |query∩doc bigrams| / |query bigrams|, computed via show_bigm + INTERSECT.
    expect(keywordLeg?.sql).toContain("show_bigm($2)");
    expect(keywordLeg?.sql).toContain("INTERSECT");
    expect(keywordLeg?.sql).not.toContain("bigm_similarity");
    // Boundary (space-padded) bigrams are stripped from the query set so short queries aren't sunk.
    expect(keywordLeg?.sql).toContain("NOT LIKE '% %'");
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
    const keywordLeg = calls.find((c) => c.sql.includes("word_similarity($2, content_normalized)"));
    // WHERE drives the GIN index on content_normalized via the operator.
    expect(keywordLeg?.sql).toContain("$2 <% content_normalized");
    expect(keywordLeg?.sql).not.toContain("word_similarity($2, content_normalized) >");
    expect(keywordLeg?.sql).toContain("word_similarity($2, content_normalized) as score");
    expect(keywordLeg?.sql).toContain("ORDER BY word_similarity($2, content_normalized) DESC");
    // The SELECT list still returns the raw content column for display.
    expect(keywordLeg?.sql).toContain("SELECT id, content,");
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

  it("CJK keyword leg keeps the =% index probe and sets the pg_bigm floor (not keywordMinScore)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { cjk: true }).hybridSearch({
      ...params,
      language: "ja",
    });
    const keywordLeg = calls.find((c) => c.sql.includes("show_bigm(content)"));
    expect(keywordLeg?.sql).toContain("content =% $2"); // gin_bigm_ops index probe retained
    expect(keywordLeg?.sql).toContain("score >= $4"); // coverage threshold predicate
    const setCall = calls.find(
      (c) => typeof c.sql === "string" && c.sql.includes("pg_bigm.similarity_limit"),
    );
    expect(setCall?.sql).toContain("set_config('pg_bigm.similarity_limit'");
    // The GUC is the low candidate-generation floor, NOT the relevance threshold.
    expect(setCall?.params).toContain("0.0001");
    expect(setCall?.params).not.toContain(String(params.keywordMinScore));
  });

  it("CJK keyword leg binds keywordMinScore as the coverage threshold ($4)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { cjk: true }).hybridSearch({
      ...params,
      language: "ja",
    });
    const keywordLeg = calls.find((c) => c.sql.includes("show_bigm(content)"));
    expect(keywordLeg?.sql).toContain("WHERE score >= $4");
    expect(keywordLeg?.params[3]).toBe(params.keywordMinScore); // $4 === keywordMinScore (0.35)
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

  // --- Finding #5(b): runTuned must NOT nest BEGIN/COMMIT when the consumer's withConnection
  // already opened an interactive transaction (e.g. postgres.js withTenantSql doing SET LOCAL
  // app.current_tenant_id for RLS). Opt out via { manageTransaction: false }: the planner GUCs
  // still apply (set_config is_local=true) in the AMBIENT txn, but the adapter emits no
  // BEGIN/COMMIT/ROLLBACK so it can't end the consumer's tenant transaction early. ---

  it("wraps tuned legs in BEGIN/COMMIT by default (manages its own transaction)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).hybridSearch(params);
    expect(calls.some((c) => c.sql === "BEGIN")).toBe(true);
    expect(calls.some((c) => c.sql === "COMMIT")).toBe(true);
  });

  it("omits BEGIN/COMMIT/ROLLBACK with manageTransaction: false but still sets GUCs and runs the SELECTs", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { manageTransaction: false }).hybridSearch(params);
    // No transaction control statements — the consumer's withConnection owns the transaction.
    expect(calls.some((c) => c.sql === "BEGIN")).toBe(false);
    expect(calls.some((c) => c.sql === "COMMIT")).toBe(false);
    expect(calls.some((c) => c.sql === "ROLLBACK")).toBe(false);
    // Planner GUCs are still applied transaction-locally (is_local=true) in the ambient txn.
    expect(
      calls.some((c) => c.sql.includes("set_config('ivfflat.probes'") && c.sql.includes("true")),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.sql.includes("set_config('pg_trgm.word_similarity_threshold'") &&
          c.sql.includes("true"),
      ),
    ).toBe(true);
    // The tuned SELECTs still ran on the ambient connection.
    expect(calls.some((c) => c.sql.includes("embedding <=> $2::vector"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("word_similarity($2, content_normalized)"))).toBe(true);
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
        if (sql.includes("word_similarity($2, content_normalized) as score")) {
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

// --- Write path: batch INSERT placeholder/cast math and scoped DELETE ---
// Exercised end-to-end only by the playground; this guards the $N offset arithmetic and the
// ::vector cast against silent regressions (the indexer tests mock RagDatabase wholesale).

describe("PostgresRagDatabase.insertChunks", () => {
  const chunk = {
    sourceType: "faq",
    sourceId: "doc-1",
    chunkIndex: "0",
    content: "hello world",
    contentNormalized: "hello world",
    language: "en",
    embedding: [0.1, 0.2, 0.3],
    metadata: '{"k":"v"}',
  };

  it("is a no-op for an empty chunk list (issues no query)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).insertChunks("t1", []);
    expect(calls).toHaveLength(0);
  });

  it("inserts in a single statement listing the columns in order", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).insertChunks("t1", [chunk]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain(
      "INSERT INTO rag_documents (tenant_id, source_type, source_id, chunk_index, content, language, embedding, metadata, content_normalized)",
    );
  });

  it("binds the 9 columns per chunk in order and serializes the embedding as a vector literal", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).insertChunks("t1", [chunk]);
    expect(calls[0].params).toEqual([
      "t1",
      "faq",
      "doc-1",
      "0",
      "hello world",
      "en",
      "[0.1,0.2,0.3]",
      '{"k":"v"}',
      "hello world",
    ]);
    // The embedding column carries the ::vector cast (7th of each row's 9 placeholders).
    expect(calls[0].sql).toContain("$7::vector");
  });

  it("batches multiple chunks into one INSERT with sequential placeholders", async () => {
    const { txProvider, calls } = recordingTx();
    const second = {
      ...chunk,
      sourceId: "doc-2",
      chunkIndex: "1",
      embedding: [0.4, 0.5, 0.6],
    };
    await new PostgresRagDatabase(txProvider).insertChunks("t1", [chunk, second]);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toHaveLength(18); // 9 per chunk
    expect(calls[0].params?.[15]).toBe("[0.4,0.5,0.6]"); // 2nd row embedding ($16)
    expect(calls[0].sql).toContain("$7::vector");
    expect(calls[0].sql).toContain("$16::vector");
    const refs = referencedPlaceholders(calls[0].sql);
    for (let n = 1; n <= 18; n++) expect(refs.has(n)).toBe(true);
    for (const ref of refs) expect(ref).toBeLessThanOrEqual(18);
  });
});

describe("PostgresRagDatabase.deleteBySource", () => {
  it("issues one parameterized DELETE scoped by tenant + source", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).deleteBySource("t1", "faq", "doc-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain(
      "DELETE FROM rag_documents WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3",
    );
    expect(calls[0].params).toEqual(["t1", "faq", "doc-1"]);
  });
});

// --- replaceSource: re-index DELETE+INSERT must be ONE transaction so a failed INSERT can never
// leave the source with the old chunks deleted and nothing in their place (silent data loss). ---

describe("PostgresRagDatabase.replaceSource", () => {
  const chunk = {
    sourceType: "faq",
    sourceId: "doc-1",
    chunkIndex: "0",
    content: "hi",
    contentNormalized: "hi",
    language: "en",
    embedding: [0.1, 0.2, 0.3],
    metadata: '{"k":"v"}',
  };

  it("emits BEGIN, DELETE, INSERT, COMMIT on one client in order (DELETE before INSERT, both in txn)", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider).replaceSource("t1", "faq", "doc-1", [chunk]);
    const sqls = calls.map((c) => c.sql.trim());
    expect(sqls[0]).toBe("BEGIN");
    expect(
      sqls.some((s) =>
        s.startsWith(
          "DELETE FROM rag_documents WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3",
        ),
      ),
    ).toBe(true);
    expect(sqls.some((s) => s.startsWith("INSERT INTO rag_documents"))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    // DELETE precedes INSERT; both inside the txn (after BEGIN, before COMMIT).
    const iDelete = sqls.findIndex((s) => s.startsWith("DELETE FROM rag_documents"));
    const iInsert = sqls.findIndex((s) => s.startsWith("INSERT INTO rag_documents"));
    expect(iDelete).toBeGreaterThan(0);
    expect(iInsert).toBeGreaterThan(iDelete);
    // DELETE scoped by tenant + source.
    expect(calls.find((c) => c.sql.trim().startsWith("DELETE"))?.params).toEqual([
      "t1",
      "faq",
      "doc-1",
    ]);
  });

  it("rolls back and surfaces the original error when the INSERT throws (no COMMIT)", async () => {
    const calls: string[] = [];
    const client: SqlClient = {
      query: async <T>(sql: string): Promise<T[]> => {
        calls.push(sql);
        if (sql.startsWith("INSERT INTO rag_documents")) throw new Error("insert boom");
        return [] as T[];
      },
    };
    const txProvider: TransactionProvider = {
      withConnection: async <T>(fn: (c: SqlClient) => Promise<T>) => fn(client),
    };
    const err = await new PostgresRagDatabase(txProvider)
      .replaceSource("t1", "faq", "doc-1", [chunk])
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("insert boom");
    expect(calls).toContain("BEGIN");
    expect(calls.some((s) => s.startsWith("DELETE FROM rag_documents"))).toBe(true);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("surfaces the original INSERT error even when the ROLLBACK itself fails", async () => {
    const client: SqlClient = {
      query: async <T>(sql: string): Promise<T[]> => {
        if (sql === "ROLLBACK") throw new Error("rollback boom");
        if (sql.startsWith("INSERT INTO rag_documents")) throw new Error("insert boom");
        return [] as T[];
      },
    };
    const txProvider: TransactionProvider = {
      withConnection: async <T>(fn: (c: SqlClient) => Promise<T>) => fn(client),
    };
    const err = await new PostgresRagDatabase(txProvider)
      .replaceSource("t1", "faq", "doc-1", [chunk])
      .catch((e) => e);
    expect((err as Error).message).toBe("insert boom");
  });

  // --- Finding #1 × #5: with manageTransaction: false the consumer's withConnection already
  // opened an interactive transaction (e.g. postgres.js withTenantSql for RLS). replaceSource
  // must run DELETE+INSERT in that ambient transaction WITHOUT its own BEGIN/COMMIT — an inner
  // COMMIT would end the consumer's tenant transaction (and discard SET LOCAL) mid-index, the
  // exact anti-pattern runTuned was changed to avoid. Atomicity still holds: a thrown INSERT
  // propagates and the consumer's transaction rolls the DELETE back. ---

  it("runs DELETE+INSERT in the ambient transaction (no BEGIN/COMMIT) when manageTransaction: false", async () => {
    const { txProvider, calls } = recordingTx();
    await new PostgresRagDatabase(txProvider, { manageTransaction: false }).replaceSource(
      "t1",
      "faq",
      "doc-1",
      [chunk],
    );
    const sqls = calls.map((c) => c.sql.trim());
    expect(sqls).not.toContain("BEGIN");
    expect(sqls).not.toContain("COMMIT");
    expect(sqls).not.toContain("ROLLBACK");
    // DELETE still precedes INSERT, both run on the consumer's connection.
    const iDelete = sqls.findIndex((s) => s.startsWith("DELETE FROM rag_documents"));
    const iInsert = sqls.findIndex((s) => s.startsWith("INSERT INTO rag_documents"));
    expect(iDelete).toBeGreaterThanOrEqual(0);
    expect(iInsert).toBeGreaterThan(iDelete);
  });

  it("rethrows without ROLLBACK when the INSERT throws and manageTransaction: false (consumer owns rollback)", async () => {
    const calls: string[] = [];
    const client: SqlClient = {
      query: async <T>(sql: string): Promise<T[]> => {
        calls.push(sql);
        if (sql.startsWith("INSERT INTO rag_documents")) throw new Error("insert boom");
        return [] as T[];
      },
    };
    const txProvider: TransactionProvider = {
      withConnection: async <T>(fn: (c: SqlClient) => Promise<T>) => fn(client),
    };
    const err = await new PostgresRagDatabase(txProvider, { manageTransaction: false })
      .replaceSource("t1", "faq", "doc-1", [chunk])
      .catch((e) => e);
    expect((err as Error).message).toBe("insert boom");
    expect(calls).not.toContain("BEGIN");
    expect(calls).not.toContain("COMMIT");
    expect(calls).not.toContain("ROLLBACK");
    expect(calls.some((s) => s.startsWith("DELETE FROM rag_documents"))).toBe(true);
  });
});

// --- runTuned applies planner GUCs inside BEGIN/COMMIT and must ROLLBACK + rethrow the
// ORIGINAL error if the tuned query fails — even if the ROLLBACK itself fails. ---

describe("PostgresRagDatabase tuned-leg error handling", () => {
  /**
   * A tx whose vector-leg main SELECT throws "select boom". BEGIN/set_config/ROLLBACK resolve
   * normally unless `rollbackThrows`, which makes ROLLBACK itself throw "rollback boom"
   * (exercising runTuned's inner "ignore rollback failure, surface the original error" catch).
   * Only the vector leg fails; the keyword and FTS legs settle so a single failure surfaces.
   */
  function failingVectorTx(opts?: { rollbackThrows?: boolean }) {
    const calls: string[] = [];
    const client: SqlClient = {
      query: async <T>(sql: string): Promise<T[]> => {
        calls.push(sql);
        if (sql.includes("ROLLBACK") && opts?.rollbackThrows) throw new Error("rollback boom");
        if (sql.includes("1 - (embedding <=> $2::vector) as score")) throw new Error("select boom");
        return [] as T[];
      },
    };
    const txProvider: TransactionProvider = {
      withConnection: async <T>(fn: (c: SqlClient) => Promise<T>) => fn(client),
    };
    return { txProvider, calls };
  }

  it("rolls back and rethrows the original error when a tuned leg's query fails", async () => {
    const { txProvider, calls } = failingVectorTx();
    const err = await new PostgresRagDatabase(txProvider).hybridSearch(params).catch((e) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.some((e) => /select boom/.test(String(e?.message)))).toBe(
      true,
    );
    // The failing leg issued a ROLLBACK on its connection.
    expect(calls).toContain("ROLLBACK");
  });

  it("surfaces the original error even when the ROLLBACK itself fails", async () => {
    const { txProvider } = failingVectorTx({ rollbackThrows: true });
    const err = await new PostgresRagDatabase(txProvider).hybridSearch(params).catch((e) => e);
    expect(err).toBeInstanceOf(AggregateError);
    const messages = (err as AggregateError).errors.map((e) => String(e?.message));
    // The original SELECT error wins; the swallowed ROLLBACK failure must not mask it.
    expect(messages.some((m) => /select boom/.test(m))).toBe(true);
    expect(messages.some((m) => /rollback boom/.test(m))).toBe(false);
  });

  // --- Finding #5(b): with manageTransaction: false the adapter must NOT emit ROLLBACK on a
  // tuned-leg failure. The consumer's withConnection owns the (interactive) transaction, so
  // rolling back here would abort their SET LOCAL tenant GUC and any prior work — strictly worse
  // than the original bug. Just rethrow and let the consumer's transaction handle cleanup. ---

  it("does not emit ROLLBACK on a tuned-leg failure when manageTransaction: false (consumer owns rollback)", async () => {
    const { txProvider, calls } = failingVectorTx();
    const err = await new PostgresRagDatabase(txProvider, { manageTransaction: false })
      .hybridSearch(params)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.some((e) => /select boom/.test(String(e?.message)))).toBe(
      true,
    );
    expect(calls).not.toContain("ROLLBACK"); // consumer's transaction owns rollback
  });
});
