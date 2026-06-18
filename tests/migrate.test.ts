import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * Dollar-quote splitting: a function body delimited by a dollar-quote tag
 * may contain line-ending semicolons that must NOT split the statement.
 * These tests drive a fixture SQL dir through ragMigrate and assert that the
 * body survives intact as a single executed statement.
 */
describe("ragMigrate dollar-quote splitting", () => {
  /** Run a single fixture migration through ragMigrate and return the migration statements executed. */
  async function runFixture(sql: string): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "pg-hybrid-rag-migrate-"));
    try {
      writeFileSync(join(dir, "100_fixture.sql"), sql);
      const { client, executedQueries } = createMockClient();
      await ragMigrate(client, { sqlDir: dir });
      // Drop bookkeeping queries — keep only the migration body statements.
      return executedQueries.filter((q) => !q.includes("_rag_migrations"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("preserves a named dollar-tag body with line-ending semicolons intact", async () => {
    const sql = [
      "CREATE OR REPLACE FUNCTION f() RETURNS void AS $func$",
      "BEGIN",
      "  PERFORM 1;",
      "  PERFORM 2;",
      "END;",
      "$func$ LANGUAGE plpgsql;",
      "SELECT 1;",
    ].join("\n");

    const statements = await runFixture(sql);

    // The whole function (open $func$ … close $func$) is one statement,
    // not split on the internal `PERFORM 1;` / `PERFORM 2;` / `END;` lines.
    const fnStmt = statements.find((s) => s.includes("$func$"));
    expect(fnStmt).toBeDefined();
    expect(fnStmt).toContain("PERFORM 1;");
    expect(fnStmt).toContain("PERFORM 2;");
    expect(fnStmt).toContain("END;");
    expect(fnStmt).toContain("LANGUAGE plpgsql");
    // The trailing SELECT is its own statement.
    expect(statements).toContain("SELECT 1");
    // Exactly two migration statements: the function and the SELECT.
    expect(statements.length).toBe(2);
  });

  it("does not close a named block on a different dollar-tag", async () => {
    // An inner bare `$$` must NOT terminate a `$do$`-opened block.
    const sql = [
      "DO $do$",
      "BEGIN",
      "  EXECUTE format('SELECT %L', $$inner;value$$);",
      "  PERFORM 1;",
      "END;",
      "$do$;",
      "SELECT 2;",
    ].join("\n");

    const statements = await runFixture(sql);

    const doStmt = statements.find((s) => s.startsWith("DO $do$"));
    expect(doStmt).toBeDefined();
    expect(doStmt).toContain("$$inner;value$$");
    expect(doStmt).toContain("PERFORM 1;");
    expect(doStmt).toContain("END;");
    expect(statements).toContain("SELECT 2");
    expect(statements.length).toBe(2);
  });

  it("still preserves bare $$ blocks with internal semicolons", async () => {
    const sql = [
      "CREATE OR REPLACE FUNCTION g() RETURNS void AS $$",
      "BEGIN",
      "  PERFORM 1;",
      "END;",
      "$$ LANGUAGE plpgsql;",
    ].join("\n");

    const statements = await runFixture(sql);

    expect(statements.length).toBe(1);
    expect(statements[0]).toContain("PERFORM 1;");
    expect(statements[0]).toContain("END;");
  });

  it("handles a mix of named and bare dollar-quote blocks in one file", async () => {
    const sql = [
      "CREATE FUNCTION a() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;",
      "CREATE FUNCTION b() RETURNS int AS $$ SELECT 2; $$ LANGUAGE sql;",
      "INSERT INTO t VALUES (1);",
    ].join("\n");

    const statements = await runFixture(sql);

    expect(statements.length).toBe(3);
    expect(statements.some((s) => s.includes("$body$") && s.includes("SELECT 1;"))).toBe(true);
    expect(statements.some((s) => s.includes("$$") && s.includes("SELECT 2;"))).toBe(true);
    expect(statements).toContain("INSERT INTO t VALUES (1)");
  });

  it("treats distinct tags independently — a $a$ open is not closed by $b$", async () => {
    const sql = [
      "DO $a$",
      "BEGIN",
      "  PERFORM $b$ not a closer; still inside $b$;",
      "  PERFORM 1;",
      "END;",
      "$a$;",
    ].join("\n");

    const statements = await runFixture(sql);

    // The entire DO block is a single statement despite the embedded $b$…$b$ and semicolons.
    expect(statements.length).toBe(1);
    expect(statements[0]).toContain("$b$ not a closer; still inside $b$");
    expect(statements[0]).toContain("PERFORM 1;");
  });

  it("keeps a statement with a trailing -- comment ending in ; as one statement", async () => {
    const sql = [
      "CREATE TABLE foo (",
      "  id int, -- primary key column; note the semicolon",
      "  name text",
      ");",
      "SELECT 1;",
    ].join("\n");
    const statements = await runFixture(sql);
    // Pre-fix: the `;` inside the -- comment truncates CREATE TABLE into two broken fragments.
    expect(statements.length).toBe(2);
    const create = statements.find((s) => s.startsWith("CREATE TABLE foo"));
    expect(create).toBeDefined();
    expect(create).toContain("name text"); // the tail survived in the same statement
    expect(create).not.toContain("--"); // comment stripped, not executed
    expect(statements).toContain("SELECT 1");
  });

  it("preserves a -- comment with a semicolon inside a dollar-quoted body", async () => {
    const sql = [
      "CREATE OR REPLACE FUNCTION g() RETURNS void AS $$",
      "BEGIN",
      "  -- inner note; keep this whole line",
      "  PERFORM 1;",
      "END;",
      "$$ LANGUAGE plpgsql;",
    ].join("\n");
    const statements = await runFixture(sql);
    expect(statements.length).toBe(1);
    expect(statements[0]).toContain("-- inner note; keep this whole line");
    expect(statements[0]).toContain("PERFORM 1;");
    expect(statements[0]).toContain("END;");
  });

  it("does not let a -- comment containing $$ open a dollar block", async () => {
    const sql = ["-- mentions $$ in a comment;", "CREATE TABLE x (id int);", "SELECT 9;"].join(
      "\n",
    );
    const statements = await runFixture(sql);
    expect(statements).toContain("CREATE TABLE x (id int)");
    expect(statements).toContain("SELECT 9");
    expect(statements.length).toBe(2);
  });

  it("does not treat -- inside a single-quoted string literal as a comment", async () => {
    const sql = ["INSERT INTO t (note) VALUES ('a -- b');", "SELECT 1;"].join("\n");
    const statements = await runFixture(sql);
    expect(statements.length).toBe(2);
    const insert = statements.find((s) => s.startsWith("INSERT INTO t"));
    expect(insert).toBeDefined();
    // The -- is data inside the string, not a comment: it and the rest of the value survive.
    expect(insert).toContain("'a -- b'");
    expect(statements).toContain("SELECT 1");
  });

  it("does not split on a line-ending semicolon inside a single-quoted string literal", async () => {
    // The first line ENDS with `;`, but it is inside the still-open '...' literal.
    const sql = ["INSERT INTO t (note) VALUES ('semi;", "colon');", "SELECT 2;"].join("\n");
    const statements = await runFixture(sql);
    expect(statements.length).toBe(2);
    const insert = statements.find((s) => s.startsWith("INSERT INTO t"));
    expect(insert).toBeDefined();
    expect(insert).toContain("'semi;");
    expect(insert).toContain("colon'");
    expect(statements).toContain("SELECT 2");
  });

  it("treats '' as an escaped quote inside a string (does not end the literal early)", async () => {
    const sql = ["INSERT INTO t (note) VALUES ('it''s -- ok; still data');", "SELECT 3;"].join(
      "\n",
    );
    const statements = await runFixture(sql);
    expect(statements.length).toBe(2);
    const insert = statements.find((s) => s.startsWith("INSERT INTO t"));
    expect(insert).toBeDefined();
    expect(insert).toContain("'it''s -- ok; still data'");
    expect(statements).toContain("SELECT 3");
  });
});
