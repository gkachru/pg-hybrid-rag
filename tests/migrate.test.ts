import { describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import type { SqlClient } from "../src/interfaces.js";
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
});
