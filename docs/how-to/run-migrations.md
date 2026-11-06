# Run migrations

`ragMigrate` creates and upgrades the tables, indexes, triggers and SQL functions the library needs. This guide covers choosing options, locating the SQL files, running migrations atomically, applying them with another migration tool, and upgrading.

## Before you begin

- A PostgreSQL server with the extensions you need. See [Prepare PostgreSQL](/how-to/prepare-postgres).
- A database role that can create tables and, unless a superuser created them already, extensions. Under row-level security this should be the owner role, not the application role. See [Isolate tenants with RLS](/how-to/multi-tenancy-rls).
- The embedding dimension of your model. It is fixed at the first run. See [Configure embeddings](/how-to/configure-embeddings).

## Steps

### 1. Choose the options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `embeddingDimensions` | `number` | `384` | Size of the `rag_documents.embedding` column (`vector(N)`). Applies only when migration 002 runs, which is on a fresh install. |
| `rls` | `boolean` | `false` | Apply row-level security policies (migrations 007 and 019) force them on the table owner (migration 021), and make an empty tenant setting match no rows instead of erroring (migration 022). |
| `cjk` | `boolean` | `false` | Create the pg_bigm extension and its GIN index (migration 009). |
| `vectorchord` | `boolean` | `false` | Replace the IVFFlat index with a VectorChord `vchordrq` index (migration 010). |
| `bm25` | `boolean` | `false` | Create the pg_textsearch BM25 indexes (migrations 011 and 015). |
| `sqlDir` | `string` | The package's `sql/` directory | Directory holding the `.sql` files. Required on 0.6.0 and earlier (step 2). |

`ragMigrate` skips an optional file by its name: files containing `rls`, `cjk`, `vectorchord` or `textsearch` are applied only when the matching option is `true`.

### 2. Locate the SQL directory

0.6.0 and earlier can't locate the directory when installed as a package; pass `sqlDir` on those versions. Passing `sqlDir` works in every version. Resolve the package's `sql/` directory through its `./sql/*` export:

```ts
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const sqlDir = dirname(require.resolve("pg-hybrid-rag/sql/001_extensions.sql"));
```

In a CommonJS module, call `require.resolve(...)` directly instead of creating `require`.

::: warning 0.6.0 and earlier
On these versions, `ragMigrate` without `sqlDir` throws `Could not auto-detect SQL directory. Pass sqlDir option to ragMigrate().` when installed as a package. Later versions resolve the package's own `sql/` directory; if that directory is missing, they throw `ragMigrate: SQL directory not found at <path>. Pass the sqlDir option to ragMigrate().`
:::

If you bundle your application and don't ship `node_modules`, copy the package's `sql/` directory into your build output and point `sqlDir` at the copy.

### 3. Create a pinned, non-transactional provider

Pass a `TransactionProvider` whose `withConnection` reserves one connection but does not open a transaction. `ragMigrate` then wraps each migration file and its tracking row in `BEGIN`/`COMMIT` and rolls back on error, so a failed file leaves no partial changes.

```ts
import postgres from "postgres";
import { ragMigrate, type SqlClient, type TransactionProvider } from "pg-hybrid-rag";

declare const sqlDir: string; // from step 2

// Connect as the role that owns the schema.
const sql = postgres("postgres://owner:change-me@localhost:5432/app", { max: 2, onnotice: () => {} });

const migrationProvider: TransactionProvider = {
  async withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    const reserved = await sql.reserve();
    try {
      return await fn({
        async query<R = Record<string, unknown>>(text: string, params: unknown[]): Promise<R[]> {
          const rows = await reserved.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
          return rows as unknown as R[];
        },
      });
    } finally {
      reserved.release();
    }
  },
};

await ragMigrate(migrationProvider, { sqlDir, embeddingDimensions: 1024 });
await sql.end();
```

Don't pass a provider that already wraps the callback in a transaction (such as `sql.begin()` or Prisma `$transaction`). `ragMigrate` issues its own `BEGIN` and `COMMIT`, which would nest inside yours.

If you pass a bare `SqlClient` instead, each statement runs on its own, without a transaction. A failure partway through a file can then leave that file half applied.

### 4. Run it once per deployment

`ragMigrate` is idempotent: it records each applied file in `_rag_migrations` and skips it next time, so you can run it at every startup. It takes no lock, though. If several instances start at once, they can try to apply the same file, and one of them can fail. Run it from a single deploy step, or serialize it with an advisory lock on one reserved connection:

```ts
import postgres from "postgres";
import { ragMigrate, type SqlClient, type TransactionProvider } from "pg-hybrid-rag";

declare const sql: postgres.Sql;
declare const sqlDir: string; // from step 2
const MIGRATION_LOCK_KEY = 72_146_331; // any constant your application reserves for this

const conn = await sql.reserve();
try {
  await conn.unsafe("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  const client: SqlClient = {
    async query<R = Record<string, unknown>>(text: string, params: unknown[]): Promise<R[]> {
      const rows = await conn.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as R[];
    },
  };
  // Every withConnection call reuses the locked connection.
  const lockedProvider: TransactionProvider = { withConnection: (fn) => fn(client) };
  await ragMigrate(lockedProvider, { sqlDir, embeddingDimensions: 1024 });
} finally {
  await conn.unsafe("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  conn.release();
}
```

### 5. Pass the same options every time

Keep the options identical on every run, typically from configuration. Omitting a flag on a later run doesn't undo anything; it only skips files you haven't applied yet. To enable a feature later, run again with the flag set. For example, `rls: true` on an existing database applies 007, 019 and 021 at that point.

### 6. Check the result

```sql
SELECT name, applied_at FROM _rag_migrations ORDER BY name;
```

## Use another migration tool

The SQL files ship in the package at `node_modules/pg-hybrid-rag/sql/`. To manage them with Flyway, Liquibase, node-pg-migrate or similar:

1. Apply the files in filename order (`001_...` to `022_...`).
2. In `002_rag_documents.sql`, replace the `__EMBEDDING_DIM__` token with your embedding dimension.
3. Skip the optional files you don't want: `007_rls_policies.sql`, `019_metadata_registry_rls.sql` , `021_force_rls.sql` and `022_rls_empty_tenant.sql` (RLS), `009_cjk_bigm.sql` (CJK), `010_vectorchord.sql` (VectorChord), `011_pg_textsearch.sql` and `015_bm25_normalized_textsearch.sql` (BM25).
4. When you upgrade the package, compare the new `sql/` directory with the files you already applied and add the new ones.

::: warning
Pick one runner. `ragMigrate` decides what to apply from the `_rag_migrations` table, keyed by filename. If you apply files with another tool and later call `ragMigrate`, it re-runs them. Some, such as the `CREATE POLICY` statements in 007 and 019, fail on a second run.
:::

## Upgrade an existing installation

1. Update the package.
2. Run `ragMigrate` with your usual options. Only files not yet recorded in `_rag_migrations` run.
3. Review the new files before running them on a large table:
   - Migrations 013 and 016 build indexes (`idx_rag_content_normalized_trgm`, `idx_rag_source`). On a large table, build them with `CREATE INDEX CONCURRENTLY` (same name and definition as in the file) before you migrate; the migration's `CREATE INDEX IF NOT EXISTS` then does nothing. `CONCURRENTLY` can't run inside the migration's transaction.
   - Migrations 004, 008, 013 and 014 rewrite every row of `rag_documents` (backfills of `content_tsvector` and `content_normalized`). Expect them to take time and lock rows on a large table.
   - Migration 017 adds the `attributes` column with a constant default (no table rewrite) and builds the `idx_rag_attributes` GIN index, which blocks writes while it builds.
   - Migration 010 (`vectorchord: true`) builds the `vchordrq` index and blocks writes while it builds.
   - Migration 020 deletes duplicate `rag_stop_words` rows (same `tenant_id`, `language` and `word`, compared exactly, so `The` and `the` both stay), keeping one of each, then adds the unique index `idx_rag_stop_words_tenant_lang_word`. Seed scripts can then use `INSERT ... ON CONFLICT DO NOTHING`; a plain `INSERT` of an existing row now fails. See [Manage stop words and synonyms](/how-to/stop-words-and-synonyms).
   - Migration 022 (`rls: true`) drops and recreates the four tenant policies by name with `NULLIF(current_setting('app.current_tenant_id', true), '')`, so a pooled session whose earlier transaction set the tenant returns zero rows instead of raising `invalid input syntax for type uuid`. A custom policy with one of those names is replaced.
   - Migration 021 (`rls: true`) forces row-level security on `rag_documents`, `rag_stop_words`, `rag_synonyms` and `rag_metadata_registry`, so the table owner is bound by the tenant policies too (superusers and `BYPASSRLS` roles stay exempt). If your application connects as the owner role without setting `app.current_tenant_id`, it sees no rows after this migration. Set the tenant on every transaction first. See [Isolate tenants with RLS](/how-to/multi-tenancy-rls).

::: tip
pgvector builds IVFFlat list centers from the rows present when the index is created. A fresh install creates `idx_rag_embedding_ivfflat` on an empty table, so rebuild it once after your first bulk load. See [Tune the vector index](/how-to/tune-vector-index).
:::

## Related

- [Prepare PostgreSQL](/how-to/prepare-postgres)
- [Connect your database driver](/how-to/connect-database-driver)
- [Configure embeddings](/how-to/configure-embeddings#change-the-embedding-dimension)
- [Isolate tenants with RLS](/how-to/multi-tenancy-rls)
- [Migrations reference](/reference/migrations)
- [Schema reference](/reference/schema)
