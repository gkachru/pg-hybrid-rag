import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlClient } from "./interfaces.js";

export interface MigrateOptions {
  /** Apply RLS policies (migration 007). Default: false. */
  rls?: boolean;
  /** Apply CJK support via pg_bigm (migration 009). Default: false. */
  cjk?: boolean;
  /** Custom path to SQL directory. Default: auto-detected from package. */
  sqlDir?: string;
}

/**
 * Apply pending RAG migrations.
 * Tracks applied migrations in a `_rag_migrations` table.
 * SQL files are read from the `sql/` directory.
 */
export async function ragMigrate(client: SqlClient, options: MigrateOptions = {}): Promise<void> {
  // Create tracking table if not exists
  await client.query(
    `CREATE TABLE IF NOT EXISTS _rag_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    [],
  );

  // Determine SQL directory (import.meta.dirname works in Bun and Node 21+)
  // CJS fallback: import.meta.dirname is undefined in CJS builds, so sqlDir is required there
  const defaultDir = import.meta.dirname ? join(import.meta.dirname, "..", "sql") : undefined;
  const sqlDir = options.sqlDir ?? defaultDir;
  if (!sqlDir) {
    throw new Error("sqlDir option is required when using CJS imports");
  }

  // Read all SQL files, sorted by name
  const files = readdirSync(sqlDir)
    .filter((f: string) => f.endsWith(".sql"))
    .sort();

  // Skip optional migrations unless explicitly requested
  const filesToApply = files
    .filter((f: string) => options.rls || !f.includes("rls"))
    .filter((f: string) => options.cjk || !f.includes("cjk"));

  // Get already-applied migrations
  const applied = await client.query<{ name: string }>(`SELECT name FROM _rag_migrations`, []);
  const appliedSet = new Set(applied.map((r) => r.name));

  // Apply pending migrations
  for (const file of filesToApply) {
    if (appliedSet.has(file)) continue;

    const sql = readFileSync(join(sqlDir, file), "utf-8");

    // Split on semicolons and execute each statement
    const statements = sql
      .split(/;\s*$/m)
      .map((s: string) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      await client.query(stmt, []);
    }

    await client.query(`INSERT INTO _rag_migrations (name) VALUES ($1)`, [file]);
  }
}
