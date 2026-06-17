import { describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import type { SqlClient, TransactionProvider } from "../src/interfaces.js";
import { ragMigrate } from "../src/migrate.js";

function createMockClient() {
  const executedQueries: string[] = [];
  const appliedMigrations: string[] = [];

  const client: SqlClient = {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    query: mock(async (sql: string, params: unknown[]): Promise<any[]> => {
      executedQueries.push(sql);

      // CREATE TABLE _rag_migrations
      if (sql.includes("_rag_migrations") && sql.includes("CREATE TABLE")) {
        return [];
      }
      // SELECT applied migrations
      if (sql.includes("SELECT name FROM _rag_migrations")) {
        return appliedMigrations.map((name) => ({ name }));
      }
      // INSERT migration record
      if (sql.includes("INSERT INTO _rag_migrations")) {
        appliedMigrations.push(params[0] as string);
        return [];
      }
      // Any other SQL (migration statements)
      return [];
    }),
  };

  return { client, executedQueries, appliedMigrations };
}

/** Like createMockClient, but exposes a TransactionProvider and can fail on a chosen statement. */
function createMockProvider(opts: { failOn?: string } = {}) {
  const executedQueries: string[] = [];
  const appliedMigrations: string[] = [];

  const client: SqlClient = {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    query: mock(async (sql: string, params: unknown[]): Promise<any[]> => {
      executedQueries.push(sql);
      if (opts.failOn && sql.includes(opts.failOn)) {
        throw new Error(`simulated failure on: ${opts.failOn}`);
      }
      if (sql.includes("_rag_migrations") && sql.includes("CREATE TABLE")) return [];
      if (sql.includes("SELECT name FROM _rag_migrations")) {
        return appliedMigrations.map((name) => ({ name }));
      }
      if (sql.includes("INSERT INTO _rag_migrations")) {
        appliedMigrations.push(params[0] as string);
        return [];
      }
      return [];
    }),
  };

  const provider: TransactionProvider = {
    withConnection: <T>(fn: (c: SqlClient) => Promise<T>): Promise<T> => fn(client),
  };

  return { provider, executedQueries, appliedMigrations };
}

describe("ragMigrate", () => {
  const sqlDir = join(import.meta.dir, "..", "sql");

  it("creates _rag_migrations table", async () => {
    const { client, executedQueries } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(
      executedQueries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS _rag_migrations")),
    ).toBe(true);
  });

  it("applies pending migrations", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir });
    // Should have applied at least the first 6 migrations (007 is RLS, excluded by default)
    expect(appliedMigrations.length).toBeGreaterThanOrEqual(6);
    expect(appliedMigrations).toContain("001_extensions.sql");
    expect(appliedMigrations).toContain("002_rag_documents.sql");
    expect(appliedMigrations).toContain("003_hybrid_indexes.sql");
  });

  it("skips RLS migration by default", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(appliedMigrations).not.toContain("007_rls_policies.sql");
  });

  it("includes RLS migration when rls: true", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir, rls: true });
    expect(appliedMigrations).toContain("007_rls_policies.sql");
  });

  it("skips CJK migration by default", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(appliedMigrations).not.toContain("009_cjk_bigm.sql");
  });

  it("includes CJK migration when cjk: true", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir, cjk: true });
    expect(appliedMigrations).toContain("009_cjk_bigm.sql");
  });

  it("does not re-apply already-applied migrations", async () => {
    const { client, appliedMigrations } = createMockClient();
    // Apply once
    await ragMigrate(client, { sqlDir });
    const firstRunCount = appliedMigrations.length;

    // Apply again — should not add more
    await ragMigrate(client, { sqlDir });
    expect(appliedMigrations.length).toBe(firstRunCount);
  });

  it("skips VectorChord migration by default", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(appliedMigrations).not.toContain("010_vectorchord.sql");
  });

  it("includes VectorChord migration when vectorchord: true", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir, vectorchord: true });
    expect(appliedMigrations).toContain("010_vectorchord.sql");
  });

  it("skips pg_textsearch migration by default", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(appliedMigrations).not.toContain("011_pg_textsearch.sql");
  });

  it("includes pg_textsearch migration when bm25: true", async () => {
    const { client, appliedMigrations } = createMockClient();
    await ragMigrate(client, { sqlDir, bm25: true });
    expect(appliedMigrations).toContain("011_pg_textsearch.sql");
  });

  it("does not emit transaction control for a bare SqlClient (backward compatible)", async () => {
    const { client, executedQueries } = createMockClient();
    await ragMigrate(client, { sqlDir });
    expect(executedQueries).not.toContain("BEGIN");
    expect(executedQueries).not.toContain("COMMIT");
  });

  it("wraps each migration file in a transaction when given a TransactionProvider", async () => {
    const { provider, executedQueries, appliedMigrations } = createMockProvider();
    await ragMigrate(provider, { sqlDir });

    const begins = executedQueries.filter((q) => q === "BEGIN").length;
    const commits = executedQueries.filter((q) => q === "COMMIT").length;
    expect(appliedMigrations.length).toBeGreaterThanOrEqual(6);
    expect(begins).toBe(appliedMigrations.length);
    expect(commits).toBe(appliedMigrations.length);
    expect(executedQueries).not.toContain("ROLLBACK");

    // The tracking-row INSERT must happen inside the transaction (BEGIN ... INSERT ... COMMIT).
    const firstBegin = executedQueries.indexOf("BEGIN");
    const firstInsert = executedQueries.findIndex((q) => q.includes("INSERT INTO _rag_migrations"));
    const firstCommit = executedQueries.indexOf("COMMIT");
    expect(firstBegin).toBeLessThan(firstInsert);
    expect(firstInsert).toBeLessThan(firstCommit);
  });

  it("rolls back and does not record a migration that fails mid-file", async () => {
    // 002_rag_documents.sql's first statement creates the rag_documents table — fail there.
    const { provider, executedQueries, appliedMigrations } = createMockProvider({
      failOn: "CREATE TABLE IF NOT EXISTS rag_documents",
    });

    await expect(ragMigrate(provider, { sqlDir })).rejects.toThrow();

    // 001 committed before the failure; 002 rolled back and not recorded.
    expect(appliedMigrations).toContain("001_extensions.sql");
    expect(appliedMigrations).not.toContain("002_rag_documents.sql");
    expect(executedQueries).toContain("ROLLBACK");
    expect(executedQueries.filter((q) => q === "COMMIT").length).toBe(1);
  });
});
