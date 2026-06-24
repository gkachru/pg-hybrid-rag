/**
 * Index-utilization integration tests — EXPLAIN every search/maintenance path against a live
 * Postgres and assert it (a) uses the intended index and (b) does not sequentially scan
 * rag_documents. The SQL+params are captured from the REAL adapter (never hand-copied, so the test
 * can't drift); the EXPLAIN runs with seq scans penalized AND the general tenant btrees hidden, so
 * each search leg must use its own vector/GIN/BM25 index. See pgHarness.ts for the full rationale.
 *
 * Gated by PG_INTEGRATION=1. Run with the custom image up (examples/docker-compose.yml):
 *   cd examples && podman compose up -d db
 *   PG_INTEGRATION=1 POSTGRES_USER=user POSTGRES_PASSWORD=password bun test tests/integration
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Bm25Fts,
  type HybridSearchParams,
  PostgresRagDatabase,
  ragMigrate,
  type SynonymLookup,
} from "../../src/index.js";
import {
  createTestDb,
  dropTestDb,
  explain,
  pickCaptured,
  RUN_INTEGRATION,
  randomVector,
  SQL_DIR,
  seed,
  seqScannedRelations,
  type TestDb,
  usedIndexes,
  uuid,
} from "./pgHarness.js";

const TENANT = uuid(1);
const NO_SYNONYMS: SynonymLookup = new Map();

/** Base search params; values are tuned so every leg actually runs (thresholds permissive). */
function searchParams(
  over: Partial<HybridSearchParams> & { language: string },
): HybridSearchParams {
  return {
    tenantId: TENANT,
    embeddingStr: `[${randomVector(7).join(",")}]`,
    query: "wireless",
    synonymLookup: NO_SYNONYMS,
    candidateLimit: 20,
    vectorMinScore: 0,
    keywordMinScore: 0.05,
    ...over,
  };
}

/** The general btrees that can satisfy the tenant filter — hidden so a SEARCH leg must use its
 *  specialized vector/GIN/BM25 index instead of "tenant btree + Sort". */
const TENANT_BTREES = ["idx_rag_tenant", "idx_rag_source"];

/**
 * Assert a captured leg uses `index` and never seq-scans rag_documents.
 * `hide` defaults to the tenant btrees (for search legs); the delete-path test passes [] so it can
 * legitimately observe idx_rag_source being chosen.
 */
async function expectIndex(
  testDb: TestDb,
  marker: (t: string) => boolean,
  index: string,
  hide: string[] = TENANT_BTREES,
) {
  const q = pickCaptured(testDb.captured, marker);
  const plan = await explain(testDb.sql, q.text, q.params, hide);
  expect(usedIndexes(plan)).toContain(index);
  expect(seqScannedRelations(plan)).not.toContain("rag_documents");
}

// Leg markers — substrings unique to each leg's SQL.
const isVector = (t: string) => t.includes("embedding <=>");
const isTrgm = (t: string) => t.includes("<% content_normalized");
const isBigm = (t: string) => t.includes("=% $2");
const isPlainto = (t: string) => t.includes("plainto_tsquery");
const isToTsquery = (t: string) => t.includes("to_tsquery(") && !t.includes("plainto_tsquery");
const isBm25 = (t: string) => t.includes("to_bm25query");
const isDelete = (t: string) => t.trimStart().startsWith("DELETE FROM rag_documents");

// ── Default install: IVFFlat + tsvector + pg_trgm ────────────────────────────
describe.skipIf(!RUN_INTEGRATION)("index usage — default (ivfflat + tsvector + trgm)", () => {
  const DB = "rag_idx_default";
  let testDb: TestDb;
  let db: PostgresRagDatabase;

  beforeAll(async () => {
    testDb = await createTestDb(DB);
    await ragMigrate(testDb.provider, { sqlDir: SQL_DIR });
    await seed(testDb, {
      tenant: TENANT,
      languages: ["en"],
      rowsPerLanguage: 300,
      sourcesPerLanguage: 20,
    });
    db = new PostgresRagDatabase(testDb.provider);
  });
  afterAll(async () => {
    await dropTestDb(testDb, DB);
  });

  test("vector leg → idx_rag_embedding_ivfflat", async () => {
    testDb.reset();
    await db.hybridSearch(searchParams({ language: "en" }));
    await expectIndex(testDb, isVector, "idx_rag_embedding_ivfflat");
  });

  test("keyword leg → idx_rag_content_normalized_trgm", async () => {
    testDb.reset();
    await db.hybridSearch(searchParams({ language: "en" }));
    await expectIndex(testDb, isTrgm, "idx_rag_content_normalized_trgm");
  });

  test("FTS leg (plainto_tsquery, single term) → idx_rag_content_fts", async () => {
    testDb.reset();
    await db.hybridSearch(searchParams({ language: "en", query: "wireless" }));
    await expectIndex(testDb, isPlainto, "idx_rag_content_fts");
  });

  test("FTS leg (to_tsquery, multi term) → idx_rag_content_fts", async () => {
    testDb.reset();
    await db.hybridSearch(searchParams({ language: "en", query: "wireless headphones" }));
    await expectIndex(testDb, isToTsquery, "idx_rag_content_fts");
  });

  test("delete/replace path → idx_rag_source (migration 016)", async () => {
    testDb.reset();
    // Target a non-existent source so the real DELETE is a no-op; the plan is what we assert.
    // replaceSource's DELETE uses the identical (tenant_id, source_type, source_id) predicate.
    await db.deleteBySource(TENANT, "doc", uuid(999999));
    await expectIndex(testDb, isDelete, "idx_rag_source", []);
  });
});

// ── All gated extensions: vchordrq + pg_bigm + pg_textsearch (BM25) ───────────
describe.skipIf(!RUN_INTEGRATION)("index usage — gated (vchordrq + bigm + bm25)", () => {
  const DB = "rag_idx_gated";
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb(DB);
    await ragMigrate(testDb.provider, {
      sqlDir: SQL_DIR,
      cjk: true,
      bm25: true,
      vectorchord: true,
    });
    await seed(testDb, {
      tenant: TENANT,
      languages: ["en", "fr", "ar", "zh"],
      rowsPerLanguage: 120,
      sourcesPerLanguage: 12,
    });
  });
  afterAll(async () => {
    await dropTestDb(testDb, DB);
  });

  test("vector leg → idx_rag_embedding_vchordrq (migration 010 swap)", async () => {
    const db = new PostgresRagDatabase(testDb.provider);
    testDb.reset();
    await db.hybridSearch(searchParams({ language: "en" }));
    await expectIndex(testDb, isVector, "idx_rag_embedding_vchordrq");
  });

  test("CJK keyword leg → idx_rag_content_bigm", async () => {
    const db = new PostgresRagDatabase(testDb.provider, { cjk: true });
    testDb.reset();
    await db.hybridSearch(searchParams({ language: "zh", query: "耳机" }));
    await expectIndex(testDb, isBigm, "idx_rag_content_bigm");
  });

  test("BM25 FTS leg (en) → idx_rag_bm25_en partial index", async () => {
    const db = new PostgresRagDatabase(testDb.provider, { fts: new Bm25Fts() });
    testDb.reset();
    await db.hybridSearch(searchParams({ language: "en" }));
    await expectIndex(testDb, isBm25, "idx_rag_bm25_en");
  });

  test("BM25 FTS leg (ar, unsupported) → idx_rag_bm25_simple catch-all", async () => {
    const db = new PostgresRagDatabase(testDb.provider, { fts: new Bm25Fts() });
    testDb.reset();
    await db.hybridSearch(searchParams({ language: "ar", query: "سماعات" }));
    await expectIndex(testDb, isBm25, "idx_rag_bm25_simple");
  });
});
