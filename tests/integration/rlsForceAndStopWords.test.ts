/**
 * Migrations 020 (unique stop words) and 021 (FORCE row-level security) against a REAL Postgres.
 *
 * - 020 removes existing duplicate stop words, then rejects new ones.
 * - 021 makes the tenant policies apply to a non-superuser table OWNER: without
 *   app.current_tenant_id it sees no rows, with it only its tenant's rows. Before 021 the owner
 *   saw every tenant's rows.
 *
 * Gated by PG_INTEGRATION=1. Roles are cluster-wide, so the role name is unique per run.
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
const DB_NAME = `rag_it_force_${SUFFIX}`;
const OWNER = `rag_it_owner_${SUFFIX}`;
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const TABLES = ["rag_documents", "rag_stop_words", "rag_synonyms", "rag_metadata_registry"];

describe.skipIf(!RUN_INTEGRATION)("migrations 020 + 021 (live Postgres)", () => {
  let testDb: TestDb;
  let oldSqlDir: string;

  /** Run `text` as the owner role on one session, with app.current_tenant_id set if given. */
  async function asOwner(tenant: string | null, text: string): Promise<Record<string, unknown>[]> {
    const conn = postgres(databaseUrl(DB_NAME), { max: 1, onnotice: () => {} });
    try {
      return await conn.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${OWNER}`);
        if (tenant)
          await tx.unsafe("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
        return [...(await tx.unsafe(text))];
      });
    } finally {
      await conn.end();
    }
  }

  beforeAll(async () => {
    testDb = await createTestDb(DB_NAME);
    // Migrate up to 019 only, from a copy of sql/ without 020/021, so 020 meets real duplicates.
    oldSqlDir = mkdtempSync(join(tmpdir(), "rag-sql-"));
    for (const f of readdirSync(SQL_DIR)) {
      if (f < "020") cpSync(join(SQL_DIR, f), join(oldSqlDir, f));
    }
    await ragMigrate(testDb.provider, { sqlDir: oldSqlDir, rls: true });

    await testDb.sql`
      INSERT INTO rag_stop_words (tenant_id, language, word) VALUES
        (${A}, 'en', 'the'), (${A}, 'en', 'the'), (${A}, 'en', 'the'),
        (${A}, 'en', 'The'), (${A}, 'de', 'the'), (${B}, 'en', 'the')`;
    const vec = `[${randomVector(1).join(",")}]`;
    await testDb.sql.unsafe(
      `INSERT INTO rag_documents (tenant_id, source_type, source_id, chunk_index, content, language, embedding)
       VALUES ($1, 'doc', gen_random_uuid(), 0, 'a', 'en', $3::vector),
              ($2, 'doc', gen_random_uuid(), 0, 'b', 'en', $3::vector),
              ($2, 'doc', gen_random_uuid(), 0, 'c', 'en', $3::vector)`,
      [A, B, vec],
    );

    await testDb.sql.unsafe(`CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    for (const t of TABLES) await testDb.sql.unsafe(`ALTER TABLE ${t} OWNER TO ${OWNER}`);
  }, 120_000);

  afterAll(async () => {
    if (oldSqlDir) rmSync(oldSqlDir, { recursive: true, force: true });
    if (testDb) await dropTestDb(testDb, DB_NAME);
    const admin = postgres(databaseUrl(), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`DROP ROLE IF EXISTS ${OWNER}`);
    } finally {
      await admin.end();
    }
  });

  test("before 021, the table owner bypasses the tenant policy", async () => {
    const rows = await asOwner(null, "SELECT count(*)::int AS n FROM rag_documents");
    expect(rows[0]?.n).toBe(3);
  });

  test("020 removes duplicate stop words and rejects new ones", async () => {
    await ragMigrate(testDb.provider, { sqlDir: SQL_DIR, rls: true });
    const rows = await testDb.sql`
      SELECT tenant_id::text AS t, language, word FROM rag_stop_words ORDER BY t, language, word COLLATE "C"`;
    expect(rows.map((r) => `${r.t.slice(0, 1)}/${r.language}/${r.word}`)).toEqual([
      "1/de/the",
      "1/en/The",
      "1/en/the",
      "2/en/the",
    ]);
    let error = "";
    try {
      await testDb.sql`INSERT INTO rag_stop_words (tenant_id, language, word) VALUES (${A}, 'en', 'the')`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    expect(error).toContain("idx_rag_stop_words_tenant_lang_word");
    const conflict = await testDb.sql`
      INSERT INTO rag_stop_words (tenant_id, language, word) VALUES (${A}, 'en', 'the')
      ON CONFLICT DO NOTHING RETURNING id`;
    expect(conflict).toHaveLength(0);
  });

  test("021 forces RLS on every tenant table", async () => {
    const rows = await testDb.sql`
      SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = ANY(${TABLES})`;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.relforcerowsecurity === true)).toBe(true);
  });

  test("after 021, the owner sees no rows without a tenant and only its tenant's rows with one", async () => {
    expect((await asOwner(null, "SELECT count(*)::int AS n FROM rag_documents"))[0]?.n).toBe(0);
    expect((await asOwner(A, "SELECT count(*)::int AS n FROM rag_documents"))[0]?.n).toBe(1);
    expect((await asOwner(B, "SELECT count(*)::int AS n FROM rag_documents"))[0]?.n).toBe(2);
    expect((await asOwner(B, "SELECT count(*)::int AS n FROM rag_stop_words"))[0]?.n).toBe(1);
  });

  test("the owner cannot write another tenant's rows", async () => {
    let error = "";
    try {
      await asOwner(
        A,
        `INSERT INTO rag_stop_words (tenant_id, language, word) VALUES ('${B}', 'en', 'x')`,
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    expect(error).toContain("row-level security");
  });
});
