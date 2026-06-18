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
 * Split SQL text into individual statements on top-level `;` terminators, skipping any `;` that is
 * not really a terminator. A single left-to-right character scan tracks the three contexts where a
 * `;` (or `--`, or `$$`) must be treated as literal:
 *
 *   - dollar-quoted blocks  — `$$ … $$` / `$func$ … $func$` (PL/pgSQL bodies). A block opens on the
 *     first tag and closes only on the matching tag, so a body with line-ending semicolons or a
 *     differently-named inner tag (`$$`, `$other$`) is preserved intact.
 *   - single-quoted strings — `'…'`, with `''` an escaped quote. A `;` or `--` inside a string
 *     literal is data, not a terminator/comment.
 *   - `--` line comments    — outside a string/block, `--` runs to end-of-line and is dropped, so a
 *     `;` inside a comment never truncates a statement and a comment containing `$$` never opens a
 *     spurious block. Inside a dollar body, `--` is literal text and is kept.
 *
 * C-style block comments (slash-star) are intentionally not handled — out of scope and unused in
 * the repo's SQL.
 */
function splitStatements(text: string): string[] {
  const statements: string[] = [];
  let current = "";
  // Persistent scan state — all three contexts can span newlines:
  let openTag: string | null = null; // open dollar-quote tag ("$$"/"$func$"), or null when outside
  let inString = false; // inside a '…' single-quoted string literal
  // Sticky matcher for a dollar-quote tag anchored exactly at a given offset.
  const tagAt = /\$[A-Za-z_]\w*\$|\$\$/y;
  const matchTag = (pos: number): string | null => {
    tagAt.lastIndex = pos;
    const m = tagAt.exec(text);
    return m ? m[0] : null;
  };

  const flush = () => {
    const clean = current.trim();
    if (clean) statements.push(clean);
    current = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // Inside a dollar-quoted body: only the matching close tag matters; `;`, `--`, `'` are literal.
    if (openTag !== null) {
      if (ch === "$") {
        const tag = matchTag(i);
        if (tag !== null) {
          current += tag;
          if (tag === openTag) openTag = null;
          i += tag.length;
          continue;
        }
      }
      current += ch;
      i++;
      continue;
    }

    // Inside a single-quoted string: `''` is an escaped quote (stay in the string); a lone `'` ends
    // it. `;`, `--`, `$$` inside are all literal data.
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        inString = false;
      }
      current += ch;
      i++;
      continue;
    }

    // Normal context.
    if (ch === "-" && text[i + 1] === "-") {
      // Line comment: drop `--` through end-of-line (leave the newline for the next iteration so
      // multi-line statements keep their structure).
      let j = i + 2;
      while (j < text.length && text[j] !== "\n") j++;
      i = j;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "$") {
      const tag = matchTag(i);
      if (tag !== null) {
        current += tag;
        openTag = tag;
        i += tag.length;
        continue;
      }
    }
    if (ch === ";") {
      // Top-level terminator: end the statement (the `;` itself is dropped, not executed).
      flush();
      i++;
      continue;
    }
    current += ch;
    i++;
  }

  // Flush a trailing statement that has no terminating `;`.
  flush();
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
