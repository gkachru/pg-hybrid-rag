/**
 * Migration 022: an EMPTY app.current_tenant_id behaves like an unset one (zero rows, no error).
 *
 * Reproduces the pooled-connection sequence on ONE session, as a role subject to RLS:
 *   BEGIN; set_config('app.current_tenant_id', <tenant>, true); ...; COMMIT;
 *   SELECT ... (no tenant set)   -- the variable now reads as '' in this session
 * Before 022 the second query raised "invalid input syntax for type uuid"; after it, zero rows.
 * Gated by PG_INTEGRATION=1. The role name is unique per run (roles are cluster-wide).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { ragMigrate } from "../../src/index.js";
import {
  createTestDb,
  databaseUrl,
  dropTestDb,
  RUN_INTEGRATION,
  randomVector,
  SQL_DIR,
  type TestDb,
} from "./pgHarness.js";

const SUFFIX = Math.random().toString(36).slice(2, 8);
const DB_NAME = `rag_it_empty_${SUFFIX}`;
const ROLE = `rag_it_empty_app_${SUFFIX}`;
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const TABLES = ["rag_documents", "rag_metadata_registry", "rag_stop_words", "rag_synonyms"];

describe.skipIf(!RUN_INTEGRATION)("migration 022: empty tenant setting (live Postgres)", () => {
  let testDb: TestDb;
  let oldSqlDir: string;

  /**
   * On one fresh session as the app role: a committed transaction sets the tenant
   * transaction-locally, then `text` runs with no tenant set. Returns the count or the error.
   */
  async function afterLocalTenant(
    text: string,
  ): Promise<{ setting?: string; rows?: number; error?: string }> {
    const conn = postgres(databaseUrl(DB_NAME), { max: 1, onnotice: () => {} });
    let setting: string | undefined;
    try {
      await conn.unsafe(`SET ROLE ${ROLE}`);
      await conn.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
      });
      const s = await conn.unsafe("SELECT current_setting('app.current_tenant_id', true) AS v");
      setting = s[0]?.v as string;
      const rows = await conn.unsafe(text);
      return { setting, rows: Number(rows[0]?.n) };
    } catch (e) {
      return { setting, error: e instanceof Error ? e.message : String(e) };
    } finally {
      await conn.end();
    }
  }

  beforeAll(async () => {
    testDb = await createTestDb(DB_NAME);
    // Migrate up to 021 only, so the first test sees the pre-022 policies.
    oldSqlDir = mkdtempSync(join(tmpdir(), "rag-sql-"));
    for (const f of readdirSync(SQL_DIR)) {
      if (f < "022") cpSync(join(SQL_DIR, f), join(oldSqlDir, f));
    }
    await ragMigrate(testDb.provider, { sqlDir: oldSqlDir, rls: true });

    const vec = `[${randomVector(1).join(",")}]`;
    await testDb.sql.unsafe(
      `INSERT INTO rag_documents (tenant_id, source_type, source_id, chunk_index, content, language, embedding)
       VALUES ($1, 'doc', gen_random_uuid(), 0, 'a', 'en', $3::vector),
              ($2, 'doc', gen_random_uuid(), 0, 'b', 'en', $3::vector)`,
      [A, B, vec],
    );
    await testDb.sql`
      INSERT INTO rag_stop_words (tenant_id, language, word) VALUES (${A}, 'en', 'the'), (${B}, 'en', 'the')`;
    await testDb.sql.unsafe(`CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await testDb.sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  }, 120_000);

  afterAll(async () => {
    if (oldSqlDir) rmSync(oldSqlDir, { recursive: true, force: true });
    if (testDb) await dropTestDb(testDb, DB_NAME);
    const admin = postgres(databaseUrl(), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`DROP ROLE IF EXISTS ${ROLE}`);
    } finally {
      await admin.end();
    }
  });

  test("before 022, a query after a finished set_config(..., true) fails on the uuid cast", async () => {
    const r = await afterLocalTenant("SELECT count(*)::int AS n FROM rag_documents");
    expect(r.setting).toBe(""); // the Postgres behavior this migration handles
    expect(r.error).toContain("invalid input syntax for type uuid");
  });

  test("022 recreates all four policies with NULLIF", async () => {
    await ragMigrate(testDb.provider, { sqlDir: SQL_DIR, rls: true });
    const rows = await testDb.sql`
      SELECT tablename, qual FROM pg_policies WHERE tablename = ANY(${TABLES}) ORDER BY tablename`;
    expect(rows.map((r) => r.tablename)).toEqual(TABLES);
    expect(rows.every((r) => String(r.qual).includes("NULLIF"))).toBe(true);
  });

  test("after 022, the same sequence returns zero rows on every tenant table", async () => {
    for (const t of TABLES) {
      const r = await afterLocalTenant(`SELECT count(*)::int AS n FROM ${t}`);
      expect(r).toEqual({ setting: "", rows: 0 });
    }
  });

  test("after 022, a session that never set the tenant still returns zero rows", async () => {
    const conn = postgres(databaseUrl(DB_NAME), { max: 1, onnotice: () => {} });
    try {
      await conn.unsafe(`SET ROLE ${ROLE}`);
      const r = await conn.unsafe("SELECT count(*)::int AS n FROM rag_documents");
      expect(r[0]?.n).toBe(0);
    } finally {
      await conn.end();
    }
  });

  test("after 022, a set tenant still sees only its own rows", async () => {
    const conn = postgres(databaseUrl(DB_NAME), { max: 1, onnotice: () => {} });
    try {
      const n = await conn.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${ROLE}`);
        await tx.unsafe("SELECT set_config('app.current_tenant_id', $1, true)", [B]);
        return (await tx.unsafe("SELECT count(*)::int AS n FROM rag_documents"))[0]?.n;
      });
      expect(n).toBe(1);
    } finally {
      await conn.end();
    }
  });
});
