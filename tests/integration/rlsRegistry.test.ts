/**
 * Row-level security for the metadata schema (migrations 017-019), against a REAL Postgres.
 *
 * App queries run as a role that is NOT the table owner, NOT superuser and has no BYPASSRLS
 * (`SET ROLE` on a reserved connection), with `app.current_tenant_id` set per session. Covers the
 * registry table's 019 policy (read + write isolation, fail-closed), CachingMetadataCatalog under
 * RLS, and the attributes column under the 007 rag_documents policy. Gated by PG_INTEGRATION=1.
 *
 * Roles are cluster-wide, so the role name is unique per run and dropped in afterAll.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  CachingMetadataCatalog,
  type HybridSearchParams,
  normalizeAttributes,
  PostgresRagDatabase,
  type RankedCandidate,
  ragMigrate,
  type SqlClient,
  serializeAttributes,
  type TransactionProvider,
  validateFilter,
} from "../../src/index.js";
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
const DB_NAME = `rag_it_rls_${SUFFIX}`;
const ROLE = `rag_it_rls_app_${SUFFIX}`;

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const ID = {
  a1: "aaaaaaaa-0000-0000-0000-000000000001",
  a2: "aaaaaaaa-0000-0000-0000-000000000002",
  b1: "bbbbbbbb-0000-0000-0000-000000000001",
  b2: "bbbbbbbb-0000-0000-0000-000000000002",
  x: "cccccccc-0000-0000-0000-000000000001",
} as const;

const CONTENT = "wireless headphones battery";

function chunk(id: keyof typeof ID, region: string, n: number) {
  return {
    sourceType: "doc",
    sourceId: ID[id],
    chunkIndex: "0",
    content: CONTENT,
    contentNormalized: CONTENT,
    language: "en",
    embedding: randomVector(n),
    metadata: "{}",
    attributes: serializeAttributes(
      normalizeAttributes([{ ns: "kx", key: "region", type: "string", value: region }]),
    ),
  };
}

const sqlClient = (run: (s: string, p: unknown[]) => Promise<unknown>): SqlClient => ({
  async query<R = Record<string, unknown>>(text: string, params: unknown[]): Promise<R[]> {
    return (await run(text, params)) as R[];
  },
});

async function errorOf(f: () => Promise<unknown>): Promise<string | null> {
  try {
    await f();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe.skipIf(!RUN_INTEGRATION)("RLS: metadata registry + attributes (live Postgres)", () => {
  let testDb: TestDb;

  /**
   * Provider running every query as the app role. With a tenant, a pooled session gets the GUC set
   * for the callback. With `null`, a brand-new session is used so the GUC has never been set.
   */
  const asApp = (tenant: string | null): TransactionProvider => ({
    async withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
      if (tenant === null) {
        const fresh = postgres(databaseUrl(DB_NAME), { max: 1, onnotice: () => {} });
        try {
          await fresh.unsafe(`SET ROLE ${ROLE}`);
          return await fn(sqlClient((s, p) => fresh.unsafe(s, p as postgres.MaybeRow[])));
        } finally {
          await fresh.end();
        }
      }
      const reserved = await testDb.sql.reserve();
      try {
        await reserved.unsafe(`SET ROLE ${ROLE}`);
        await reserved.unsafe("SELECT set_config('app.current_tenant_id', $1, false)", [tenant]);
        return await fn(sqlClient((s, p) => reserved.unsafe(s, p as postgres.MaybeRow[])));
      } finally {
        await reserved.unsafe("RESET ROLE");
        await reserved.unsafe("RESET app.current_tenant_id");
        reserved.release();
      }
    },
  });

  const q = (tenant: string | null, text: string, params: unknown[] = []) =>
    asApp(tenant).withConnection((c) => c.query<Record<string, unknown>>(text, params));

  beforeAll(async () => {
    testDb = await createTestDb(DB_NAME);
    // First without rls (019 must be skipped), then with rls (007 + 019 apply).
    await ragMigrate(testDb.provider, { sqlDir: SQL_DIR });
    const before = await testDb.sql`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'rag_metadata_registry'`;
    expect(before[0]?.n).toBe(0);
    await ragMigrate(testDb.provider, { sqlDir: SQL_DIR, rls: true });

    // Seed as the owner (superuser: bypasses RLS).
    const owner = new PostgresRagDatabase(testDb.provider);
    await owner.insertChunks(A, [chunk("a1", "EU", 1), chunk("a2", "EU", 2)]);
    await owner.insertChunks(B, [chunk("b1", "EU", 3), chunk("b2", "APAC", 4)]);
    await testDb.sql`
      INSERT INTO rag_metadata_registry (tenant_id, ns, key, description)
      VALUES (${A}, 'kx', 'region', 'A region'), (${B}, 'kx', 'secret_b', 'B only')`;

    await testDb.sql.unsafe(`CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await testDb.sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`,
    );
  }, 120_000);

  afterAll(async () => {
    if (testDb) await dropTestDb(testDb, DB_NAME);
    const admin = postgres(databaseUrl(), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`DROP ROLE IF EXISTS ${ROLE}`);
    } finally {
      await admin.end();
    }
  });

  test("setup: RLS on all tenant tables, registry policy present, app role cannot bypass", async () => {
    const tables = await testDb.sql`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('rag_documents', 'rag_metadata_registry', 'rag_stop_words', 'rag_synonyms')`;
    expect(tables).toHaveLength(4);
    expect(tables.every((t) => t.relrowsecurity === true)).toBe(true);
    const policy = await testDb.sql`
      SELECT cmd FROM pg_policies WHERE tablename = 'rag_metadata_registry'`;
    expect(policy.map((p) => p.cmd)).toEqual(["ALL"]);
    const role = await testDb.sql`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${ROLE}`;
    expect(role[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  describe("rag_metadata_registry", () => {
    test("GUC never set: zero rows (fail closed)", async () => {
      const rows = await q(null, "SELECT count(*)::int AS n FROM rag_metadata_registry");
      expect(rows[0]?.n).toBe(0);
    });

    test("tenant A sees only its own rows, even when asking for B", async () => {
      const own = await q(A, "SELECT tenant_id::text AS t, key FROM rag_metadata_registry");
      expect(own).toEqual([{ t: A, key: "region" }]);
      const other = await q(
        A,
        "SELECT count(*)::int AS n FROM rag_metadata_registry WHERE tenant_id = $1",
        [B],
      );
      expect(other[0]?.n).toBe(0);
    });

    test("tenant A cannot insert a B row or move its row to B", async () => {
      const insert = await errorOf(() =>
        q(
          A,
          "INSERT INTO rag_metadata_registry (tenant_id, ns, key, description) VALUES ($1, 'kx', 'x', 'x')",
          [B],
        ),
      );
      expect(insert).toContain("row-level security");
      const move = await errorOf(() =>
        q(A, "UPDATE rag_metadata_registry SET tenant_id = $1 WHERE tenant_id = $2", [B, A]),
      );
      expect(move).toContain("row-level security");
    });

    test("tenant A UPDATE/DELETE of B rows affect nothing", async () => {
      const upd = await q(
        A,
        "UPDATE rag_metadata_registry SET description = 'changed' WHERE tenant_id = $1 RETURNING 1",
        [B],
      );
      const del = await q(A, "DELETE FROM rag_metadata_registry WHERE tenant_id = $1 RETURNING 1", [
        B,
      ]);
      expect(upd).toHaveLength(0);
      expect(del).toHaveLength(0);
      const b =
        await testDb.sql`SELECT description FROM rag_metadata_registry WHERE tenant_id = ${B}`;
      expect(b.map((r) => r.description)).toEqual(["B only"]);
    });

    test("GUC set then RESET on a pooled session returns zero rows (migration 022)", async () => {
      // A reset custom GUC reads as '' (not NULL). Before 022, ''::uuid raised an error; 022's
      // NULLIF maps '' to NULL, so the policy matches no rows, like a never-set session.
      const reserved = await testDb.sql.reserve();
      try {
        await reserved.unsafe(`SET ROLE ${ROLE}`);
        await reserved.unsafe("SELECT set_config('app.current_tenant_id', $1, false)", [A]);
        await reserved.unsafe("RESET app.current_tenant_id");
        let rows: unknown[] = [];
        const err = await errorOf(async () => {
          rows = [...(await reserved.unsafe("SELECT * FROM rag_metadata_registry"))];
        });
        expect(err).toBeNull();
        expect(rows).toHaveLength(0);
      } finally {
        await reserved.unsafe("RESET ROLE");
        reserved.release();
      }
    });
  });

  describe("CachingMetadataCatalog", () => {
    test("describe(A) on an A session returns only A keys", async () => {
      const cat = new CachingMetadataCatalog({ txProvider: asApp(A) });
      const keys = (await cat.describe(A)).keys.map((k) => `${k.ns}/${k.key}`);
      expect(keys).toEqual(["kx/region"]);
    });

    test("describe(B) on an A session, or with no tenant set, is empty", async () => {
      expect((await new CachingMetadataCatalog({ txProvider: asApp(A) }).describe(B)).keys).toEqual(
        [],
      );
      expect(
        (await new CachingMetadataCatalog({ txProvider: asApp(null) }).describe(A)).keys,
      ).toEqual([]);
    });

    test("register(B) on an A session is rejected; register(A) upserts", async () => {
      const err = await errorOf(() =>
        new CachingMetadataCatalog({ txProvider: asApp(A) }).register(B, [
          { ns: "kx", key: "y", description: "y" },
        ]),
      );
      expect(err).toContain("row-level security");
      await new CachingMetadataCatalog({ txProvider: asApp(A) }).register(A, [
        { ns: "kx", key: "region", description: "updated" },
      ]);
      const row = await testDb.sql`
        SELECT description FROM rag_metadata_registry WHERE tenant_id = ${A} AND key = 'region'`;
      expect(row[0]?.description).toBe("updated");
    });
  });

  describe("rag_documents.attributes", () => {
    const v = validateFilter({ ns: "kx", key: "region", op: "equals", value: "EU" });
    if (!v.ok) throw new Error(v.errors.join("; "));
    const params = (tenantId: string): HybridSearchParams => ({
      tenantId,
      embeddingStr: `[${randomVector(1).join(",")}]`,
      query: CONTENT,
      synonymLookup: new Map(),
      language: "en",
      candidateLimit: 20,
      vectorMinScore: -1,
      keywordMinScore: 0.05,
      attributeFilter: v.filter,
    });
    const ids = (r: Record<string, RankedCandidate[]>) =>
      [...new Set(Object.values(r).flatMap((rows) => rows.map((x) => String(x.sourceId))))].sort();

    test("filtered search on an A session returns only A articles", async () => {
      const r = await new PostgresRagDatabase(asApp(A)).hybridSearch(params(A));
      expect(ids(r)).toEqual([ID.a1, ID.a2]);
    });

    test("tenantId B on an A session, or no tenant set, returns nothing", async () => {
      expect(ids(await new PostgresRagDatabase(asApp(A)).hybridSearch(params(B)))).toEqual([]);
      expect(ids(await new PostgresRagDatabase(asApp(null)).hybridSearch(params(A)))).toEqual([]);
    });

    test("tenant A cannot match B's attribute values or insert rows for B", async () => {
      const apac = await q(
        A,
        "SELECT count(*)::int AS n FROM rag_documents WHERE attributes @> $1::text::jsonb",
        [JSON.stringify([{ ns: "kx", k: "region", t: "string", v: "APAC" }])],
      );
      expect(apac[0]?.n).toBe(0);
      const err = await errorOf(() =>
        new PostgresRagDatabase(asApp(A)).insertChunks(B, [chunk("x", "EU", 9)]),
      );
      expect(err).toContain("row-level security");
    });
  });
});
