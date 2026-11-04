/**
 * Selective-filter under-return coverage (spec §6.5), against a REAL Postgres.
 *
 * Question: with an attribute filter matching 2% of a 20,000-row tenant (400 rows), does each search
 * leg still return a full `candidateLimit` (40) rows? Approximate / top-K legs can under-return
 * because the filter is applied AFTER the index scan has already picked its top-K candidates.
 *
 * Random vectors (this counts rows returned, it does not measure recall) and one shared content
 * string so the keyword and FTS legs match every row. Gated by PG_INTEGRATION=1.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  assertValidFilter,
  Bm25Fts,
  type HybridSearchParams,
  normalizeAttributes,
  PostgresRagDatabase,
  ragMigrate,
  type SqlClient,
  type SynonymLookup,
  serializeAttributes,
  type TransactionProvider,
} from "../../src/index.js";
import {
  createTestDb,
  dropTestDb,
  explain,
  pickCaptured,
  RUN_INTEGRATION,
  randomVector,
  SQL_DIR,
  type TestDb,
  usedIndexes,
  uuid,
} from "./pgHarness.js";

const TENANT = uuid(1);
const CONTENT = "wireless headphones battery charging";
const ROWS = 20_000;
const RARE_EVERY = 50; // 1 in 50 = 2% = 400 rows
const CANDIDATE_LIMIT = 40;
const BATCH = 1000;
const SETUP_TIMEOUT_MS = 900_000;
const TEST_TIMEOUT_MS = 120_000;
const NO_SYNONYMS: SynonymLookup = new Map();

const FILTER = assertValidFilter({ key: "segment", op: "equals", value: "rare" });

const RARE_ATTRS = serializeAttributes(
  normalizeAttributes([{ ns: "kx", key: "segment", type: "string", value: "rare" }]),
);
const COMMON_ATTRS = serializeAttributes(
  normalizeAttributes([{ ns: "kx", key: "segment", type: "string", value: "common" }]),
);

function params(over: Partial<HybridSearchParams> = {}): HybridSearchParams {
  return {
    tenantId: TENANT,
    embeddingStr: `[${randomVector(7).join(",")}]`,
    query: "wireless headphones",
    synonymLookup: NO_SYNONYMS,
    language: "en",
    candidateLimit: CANDIDATE_LIMIT,
    vectorMinScore: -1,
    keywordMinScore: 0.05,
    attributeFilter: FILTER,
    ...over,
  };
}

/** Seed ROWS rows in batches through the real adapter insert path. */
async function seedRows(testDb: TestDb): Promise<void> {
  const db = new PostgresRagDatabase(testDb.provider);
  for (let start = 0; start < ROWS; start += BATCH) {
    const chunks = [];
    for (let i = start; i < start + BATCH; i++) {
      chunks.push({
        sourceType: "doc",
        sourceId: uuid(10_000 + i),
        chunkIndex: "0",
        content: CONTENT,
        contentNormalized: CONTENT,
        language: "en",
        embedding: randomVector(i + 1),
        metadata: "{}",
        attributes: i % RARE_EVERY === 0 ? RARE_ATTRS : COMMON_ATTRS,
      });
    }
    await db.insertChunks(TENANT, chunks);
  }
}

/** The planner's choice for a captured leg (no index hiding: the real production plan). */
async function planIndexes(testDb: TestDb, marker: (t: string) => boolean): Promise<string[]> {
  const q = pickCaptured(testDb.captured, marker);
  return usedIndexes(await explain(testDb.sql, q.text, q.params, []));
}

const isVector = (t: string) => t.includes("embedding <=>");
const isTrgm = (t: string) => t.includes("<% content_normalized");
const isTsvector = (t: string) => t.includes("content_tsvector @@");
const isBm25 = (t: string) => t.includes("to_bm25query");

/**
 * Provider wrapper that sets `enable_seqscan = off` on the connection for the duration of each
 * callback, so a leg with no usable exact path must use its approximate index (not a seq scan).
 */
function noSeqScan(inner: TransactionProvider): TransactionProvider {
  return {
    async withConnection<T>(fn: (c: SqlClient) => Promise<T>): Promise<T> {
      return inner.withConnection(async (client) => {
        await client.query("SET enable_seqscan = off", []);
        try {
          return await fn(client);
        } finally {
          await client.query("RESET enable_seqscan", []);
        }
      });
    },
  };
}

/** Indexes that give the planner an EXACT path for a filtered leg (attribute GIN, tenant btrees). */
const EXACT_PATH_INDEXES = ["idx_rag_attributes", "idx_rag_tenant", "idx_rag_source"];

async function dropExactPaths(testDb: TestDb): Promise<void> {
  for (const idx of EXACT_PATH_INDEXES) {
    await testDb.sql.unsafe(`DROP INDEX IF EXISTS ${idx}`);
  }
  await testDb.sql.unsafe("ANALYZE rag_documents");
}

describe.skipIf(!RUN_INTEGRATION)(
  "selective filter under-return — ivfflat + trgm + tsvector",
  () => {
    const DB = "rag_underreturn_default";
    let testDb: TestDb;

    beforeAll(async () => {
      testDb = await createTestDb(DB);
      await ragMigrate(testDb.provider, { sqlDir: SQL_DIR });
      await seedRows(testDb);
      // The ivfflat index was built on an empty table (no trained centroids): rebuild it on real data.
      await testDb.sql.unsafe("REINDEX INDEX idx_rag_embedding_ivfflat");
      await testDb.sql.unsafe("ANALYZE rag_documents");
      testDb.reset();
    }, SETUP_TIMEOUT_MS);
    afterAll(async () => {
      await dropTestDb(testDb, DB);
    });

    describe("planner's natural plan (all indexes present)", () => {
      test(
        "all legs return candidateLimit rows",
        async () => {
          const db = new PostgresRagDatabase(testDb.provider);
          testDb.reset();
          const r = await db.hybridSearch(params());
          console.log(
            `[under-return] natural plan (default DB): vector=${r.vectorRows.length} ` +
              `trgm=${r.keywordRows.length} tsvector=${r.ftsRows.length}; plans: ` +
              `vector=${await planIndexes(testDb, isVector)} trgm=${await planIndexes(testDb, isTrgm)} ` +
              `tsvector=${await planIndexes(testDb, isTsvector)}`,
          );
          expect(r.vectorRows.length).toBe(40);
          expect(r.keywordRows.length).toBe(40);
          expect(r.ftsRows.length).toBe(40);
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("forced onto each leg's own index (exact-path indexes dropped)", () => {
      beforeAll(async () => {
        await dropExactPaths(testDb);
      }, SETUP_TIMEOUT_MS);

      test(
        "ivfflat with relaxed_order + max_probes 100: vector leg returns candidateLimit rows",
        async () => {
          const db = new PostgresRagDatabase(noSeqScan(testDb.provider), {
            ivfflatIterativeScan: "relaxed_order",
            ivfflatMaxProbes: 100,
          });
          testDb.reset();
          const r = await db.hybridSearch(params());
          const idx = await planIndexes(testDb, isVector);
          console.log(`[under-return] ivfflat relaxed_order vector rows=${r.vectorRows.length}`);
          expect(idx).toContain("idx_rag_embedding_ivfflat");
          expect(r.vectorRows.length).toBe(40);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "trgm keyword leg and tsvector FTS leg return candidateLimit rows",
        async () => {
          const db = new PostgresRagDatabase(noSeqScan(testDb.provider));
          testDb.reset();
          const r = await db.hybridSearch(params());
          const trgm = await planIndexes(testDb, isTrgm);
          const fts = await planIndexes(testDb, isTsvector);
          console.log(
            `[under-return] trgm keyword rows=${r.keywordRows.length} tsvector fts rows=${r.ftsRows.length}`,
          );
          expect(trgm).toContain("idx_rag_content_normalized_trgm");
          expect(fts).toContain("idx_rag_content_fts");
          expect(r.keywordRows.length).toBe(40);
          expect(r.ftsRows.length).toBe(40);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "ivfflat with iterative scan off: log the count (documents the problem, not asserted)",
        async () => {
          const db = new PostgresRagDatabase(noSeqScan(testDb.provider));
          testDb.reset();
          const r = await db.hybridSearch(params());
          console.log(
            `[under-return] ivfflat iterative_scan=off vector rows=${r.vectorRows.length}`,
          );
          expect(r.vectorRows.length).toBeLessThanOrEqual(CANDIDATE_LIMIT);
        },
        TEST_TIMEOUT_MS,
      );
    });
  },
);

describe.skipIf(!RUN_INTEGRATION)("selective filter under-return — vchordrq + BM25", () => {
  const DB = "rag_underreturn_gated";
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb(DB);
    await ragMigrate(testDb.provider, { sqlDir: SQL_DIR, bm25: true, vectorchord: true });
    await seedRows(testDb);
    await testDb.sql.unsafe("ANALYZE rag_documents");
    testDb.reset();
  }, SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await dropTestDb(testDb, DB);
  });

  describe("planner's natural plan (all indexes present)", () => {
    test(
      "vector and BM25 legs return candidateLimit rows",
      async () => {
        const db = new PostgresRagDatabase(testDb.provider, { fts: new Bm25Fts() });
        testDb.reset();
        const r = await db.hybridSearch(params());
        console.log(
          `[under-return] natural plan (gated DB): vector=${r.vectorRows.length} bm25=${r.ftsRows.length}; plans: ` +
            `vector=${await planIndexes(testDb, isVector)} bm25=${await planIndexes(testDb, isBm25)}`,
        );
        expect(r.vectorRows.length).toBe(40);
        expect(r.ftsRows.length).toBe(40);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("forced onto each leg's own index (exact-path indexes dropped)", () => {
    beforeAll(async () => {
      await dropExactPaths(testDb);
    }, SETUP_TIMEOUT_MS);

    test(
      "vchordrq: vector leg returns candidateLimit rows",
      async () => {
        const db = new PostgresRagDatabase(noSeqScan(testDb.provider), { fts: new Bm25Fts() });
        testDb.reset();
        const r = await db.hybridSearch(params());
        const idx = await planIndexes(testDb, isVector);
        console.log(`[under-return] vchordrq vector rows=${r.vectorRows.length}`);
        expect(idx).toContain("idx_rag_embedding_vchordrq");
        expect(r.vectorRows.length).toBe(40);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "BM25 FTS leg returns candidateLimit rows",
      async () => {
        const db = new PostgresRagDatabase(noSeqScan(testDb.provider), { fts: new Bm25Fts() });
        testDb.reset();
        const r = await db.hybridSearch(params());
        const idx = await planIndexes(testDb, isBm25);
        console.log(`[under-return] bm25 fts rows=${r.ftsRows.length}`);
        expect(idx).toContain("idx_rag_bm25_en");
        expect(r.ftsRows.length).toBe(40);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
