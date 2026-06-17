import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlClient, TransactionProvider } from "./interfaces.js";

export interface MigrateOptions {
  /** Apply RLS policies (migration 007). Default: false. */
  rls?: boolean;
  /** Apply CJK support via pg_bigm (migration 009). Default: false. */
  cjk?: boolean;
  /** Apply VectorChord vchordrq index (migration 010). Requires shared_preload_libraries='vchord'. Default: false. */
  vectorchord?: boolean;
  /** Apply pg_textsearch BM25 indexes (migration 011). Requires shared_preload_libraries includes 'pg_textsearch'. Default: false. */
  bm25?: boolean;
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
 * but skip semicolons inside dollar-quoted blocks (PL/pgSQL functions).
 *
 * Handles both bare `$$` and named tags (`$func$`, `$do$`). A block opens on
 * the first dollar-quote tag and closes only on the matching tag, so a body
 * delimited by `$func$ … $func$` is preserved intact even if it contains
 * line-ending semicolons or a differently-named nested tag (`$$`, `$other$`).
 */
function splitStatements(text: string): string[] {
  const lines = text.split("\n");
  const statements: string[] = [];
  let current = "";
  // The currently-open dollar-quote tag (e.g. "$$" or "$func$"), or null when
  // outside any block. Open on the first tag seen, close only on a matching tag.
  let openTag: string | null = null;
  const tagPattern = /\$[A-Za-z_]\w*\$|\$\$/g;

  for (const line of lines) {
    // Scan dollar-quote tags left-to-right, opening/closing the block as we go.
    for (const match of line.matchAll(tagPattern)) {
      const tag = match[0];
      if (openTag === null) {
        openTag = tag;
      } else if (tag === openTag) {
        openTag = null;
      }
      // A non-matching tag while a block is open is body text — ignore it.
    }

    current += (current ? "\n" : "") + line;

    // Only split on trailing semicolons when outside a dollar-quoted block.
    if (openTag === null && line.trimEnd().endsWith(";")) {
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

function isTransactionProvider(x: SqlClient | TransactionProvider): x is TransactionProvider {
  return typeof (x as TransactionProvider).withConnection === "function";
}

export async function ragMigrate(
  clientOrProvider: SqlClient | TransactionProvider,
  options: MigrateOptions = {},
): Promise<void> {
  // When a TransactionProvider is supplied, each migration file is applied atomically
  // inside a single withConnection scope (BEGIN/COMMIT, ROLLBACK on error). A bare
  // SqlClient keeps the legacy non-atomic behavior — it can't guarantee a single session,
  // so emitting transaction control across pooled connections would be unsafe.
  const transactional = isTransactionProvider(clientOrProvider);
  const withConn: <T>(fn: (c: SqlClient) => Promise<T>) => Promise<T> = transactional
    ? (fn) => (clientOrProvider as TransactionProvider).withConnection(fn)
    : (fn) => fn(clientOrProvider as SqlClient);

  // Create tracking table if not exists (idempotent — no transaction needed)
  await withConn((client) =>
    client.query(
      `CREATE TABLE IF NOT EXISTS _rag_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
      [],
    ),
  );

  // Determine SQL directory via fallback chain:
  // 1. Explicit sqlDir option (always wins)
  // 2. import.meta.dirname (ESM — Bun and Node 21.2+)
  // 3. __dirname (CJS — Node 18+, NestJS default)
  // Indirect access via new Function avoids esbuild static analysis warnings.
  let defaultDir: string | undefined;
  try {
    const dir = new Function("return import.meta.dirname")() as string | undefined;
    defaultDir = dir ? join(dir, "..", "sql") : undefined;
  } catch {
    // Not in ESM or import.meta unavailable
  }
  if (!defaultDir) {
    try {
      const dir = new Function(
        "return typeof __dirname !== 'undefined' ? __dirname : undefined",
      )() as string | undefined;
      if (dir) defaultDir = join(dir, "..", "sql");
    } catch {
      // __dirname not available
    }
  }
  const sqlDir = options.sqlDir ?? defaultDir;
  if (!sqlDir) {
    throw new Error("Could not auto-detect SQL directory. Pass sqlDir option to ragMigrate().");
  }

  // Read all SQL files, sorted by name
  const files = readdirSync(sqlDir)
    .filter((f: string) => f.endsWith(".sql"))
    .sort();

  // Skip optional migrations unless explicitly requested
  const filesToApply = files
    .filter((f: string) => options.rls || !f.includes("rls"))
    .filter((f: string) => options.cjk || !f.includes("cjk"))
    .filter((f: string) => options.vectorchord || !f.includes("vectorchord"))
    .filter((f: string) => options.bm25 || !f.includes("textsearch"));

  // Get already-applied migrations
  const applied = await withConn((client) =>
    client.query<{ name: string }>(`SELECT name FROM _rag_migrations`, []),
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  // Apply pending migrations — one withConnection scope (and one transaction) per file.
  for (const file of filesToApply) {
    if (appliedSet.has(file)) continue;

    const sql = readFileSync(join(sqlDir, file), "utf-8");

    // Split on semicolons at end-of-line, but preserve $$-delimited blocks intact
    const statements = splitStatements(sql);

    await withConn(async (client) => {
      if (transactional) await client.query("BEGIN", []);
      try {
        for (const stmt of statements) {
          await client.query(stmt, []);
        }
        await client.query(`INSERT INTO _rag_migrations (name) VALUES ($1)`, [file]);
        if (transactional) await client.query("COMMIT", []);
      } catch (err) {
        if (transactional) {
          // Best-effort rollback; surface the original error regardless.
          try {
            await client.query("ROLLBACK", []);
          } catch {
            // ignore rollback failure
          }
        }
        throw err;
      }
    });
  }
}
