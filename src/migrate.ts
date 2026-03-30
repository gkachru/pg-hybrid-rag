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
/**
 * Split SQL text into statements on `;` at end-of-line,
 * but skip semicolons inside $$-delimited blocks (PL/pgSQL functions).
 */
function splitStatements(text: string): string[] {
  const lines = text.split("\n");
  const statements: string[] = [];
  let current = "";
  let inDollarBlock = false;

  for (const line of lines) {
    // Track $$ delimiters (toggle on each occurrence)
    const dollarMatches = line.match(/\$\$/g);
    if (dollarMatches) {
      for (const _ of dollarMatches) {
        inDollarBlock = !inDollarBlock;
      }
    }

    current += (current ? "\n" : "") + line;

    // Only split on trailing semicolons when outside $$ blocks
    if (!inDollarBlock && line.trimEnd().endsWith(";")) {
      const stmt = current.trim();
      // Remove trailing semicolons for execution
      const clean = stmt.replace(/;\s*$/, "").trim();
      if (clean) statements.push(clean);
      current = "";
    }
  }

  // Flush any remaining text
  const remaining = current.trim().replace(/;\s*$/, "").trim();
  if (remaining) statements.push(remaining);

  return statements;
}

export async function ragMigrate(client: SqlClient, options: MigrateOptions = {}): Promise<void> {
  // Create tracking table if not exists
  await client.query(
    `CREATE TABLE IF NOT EXISTS _rag_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    [],
  );

  // Determine SQL directory.
  // ESM: import.meta.dirname works in Bun and Node 21.2+.
  // CJS: import.meta is empty, so sqlDir option is required.
  // The indirect access avoids esbuild's static import.meta warning for CJS builds.
  let defaultDir: string | undefined;
  try {
    const dir = new Function("return import.meta.dirname")() as string | undefined;
    defaultDir = dir ? join(dir, "..", "sql") : undefined;
  } catch {
    defaultDir = undefined;
  }
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

    // Split on semicolons at end-of-line, but preserve $$-delimited blocks intact
    const statements = splitStatements(sql);

    for (const stmt of statements) {
      await client.query(stmt, []);
    }

    await client.query(`INSERT INTO _rag_migrations (name) VALUES ($1)`, [file]);
  }
}
