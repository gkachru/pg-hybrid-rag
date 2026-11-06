# Migrations

This page specifies `ragMigrate`, its options, how it tracks and applies the SQL files shipped in the package's `sql/` directory, and what each migration (001-021) does.

```ts
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { ragMigrate } from "pg-hybrid-rag";

const require = createRequire(import.meta.url);
const sqlDir = dirname(require.resolve("pg-hybrid-rag/sql/001_extensions.sql"));

await ragMigrate(txProvider, { sqlDir, embeddingDimensions: 1024 });
```

## ragMigrate

<!-- no-check -->
```ts
function ragMigrate(
  clientOrProvider: SqlClient | TransactionProvider,
  options?: MigrateOptions,
): Promise<void>;
```

Applies every pending migration file in name order, records each in `_rag_migrations`, and resolves when all are applied. It rejects with the first error and stops there; files after the failing one are not attempted.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `clientOrProvider` | `SqlClient \| TransactionProvider` | Where to run the SQL. Any object with a `withConnection` function is treated as a `TransactionProvider`. |
| `options` | `MigrateOptions` | See [MigrateOptions](#migrateoptions). Defaults to `{}`. |

### SqlClient vs TransactionProvider

| Passed | Behavior per migration file |
|--------|-----------------------------|
| `TransactionProvider` | One `withConnection` call per file. Runs `BEGIN`, every statement of the file, the `_rag_migrations` insert, then `COMMIT`. On error it runs `ROLLBACK` and rethrows, so a file is applied completely or not at all. |
| `SqlClient` | Statements run one by one with no transaction control, because a bare client cannot guarantee a single session. If a statement fails, the earlier statements of that file stay applied and the file is not recorded, so the next run retries the whole file. |

::: warning
With a bare `SqlClient`, retrying a partly applied file can fail, because not every statement is idempotent. For example, `CREATE POLICY` in migrations 007 and 019 has no `IF NOT EXISTS`. Prefer a `TransactionProvider`.
:::

### Steps

1. Create the tracking table if it does not exist:

   ```sql
   CREATE TABLE IF NOT EXISTS _rag_migrations (
     name TEXT PRIMARY KEY,
     applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )
   ```

2. Resolve the SQL directory (see [SQL directory](#sql-directory)): `options.sqlDir`, else the package's own `sql/` directory. Throw if the directory does not exist.
3. List every `*.sql` file in it, sorted by file name.
4. Drop optional files whose name contains `rls`, `cjk`, `vectorchord` or `textsearch` unless the matching option is `true`.
5. Read the applied file names from `_rag_migrations` and skip those.
6. For each remaining file: replace every `__EMBEDDING_DIM__` token with `embeddingDimensions`, split it into statements, run them (each with an empty parameter list), and insert the file name into `_rag_migrations`.

### Idempotence

- A file is applied at most once; re-running `ragMigrate` with the same options does nothing.
- Options apply to pending files only. Enabling an option later (for example `bm25: true`) applies its files on the next run. Disabling an option later does not undo anything.
- Editing a file that is already recorded has no effect; tracking is by file name only.

### SQL directory

The directory is chosen in this order:

1. `options.sqlDir`, when given.
2. The package's own `sql/` directory: `<module directory>/../sql`, where the module directory is derived from `import.meta.url` (the CommonJS build gets `import.meta.url` from a build-time shim). This works from the ESM build, the CommonJS build and the TypeScript source.

If the chosen directory does not exist, `ragMigrate` throws `ragMigrate: SQL directory not found at <path>. Pass the sqlDir option to ragMigrate().`

::: info
Version 0.6.0 and earlier can't locate the directory when installed as a package; pass `sqlDir` on those versions. Passing `sqlDir` works in every version.
:::

To pass `sqlDir` explicitly, resolve the package's `sql/` folder through the `pg-hybrid-rag/sql/*` package export:

```ts
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { ragMigrate } from "pg-hybrid-rag";

const require = createRequire(import.meta.url);
const sqlDir = dirname(require.resolve("pg-hybrid-rag/sql/001_extensions.sql"));
await ragMigrate(txProvider, { sqlDir });
```

Every `.sql` file in the directory is a candidate, including files you add, subject to the same name-based option filter.

### Statement splitting

Files are split on top-level `;`. A `;` is not treated as a terminator inside a dollar-quoted body (`$$ ... $$` or a named tag such as `$func$ ... $func$`, closed only by the matching tag), inside a single-quoted string (with `''` as an escaped quote), or inside a `--` line comment. Line comments outside strings and dollar-quoted bodies are removed. Block comments (`/* ... */`) are not handled.

## MigrateOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rls` | `boolean` | `false` | Apply row-level security (migrations 007, 019 and 021). |
| `cjk` | `boolean` | `false` | Apply pg_bigm support for Chinese, Japanese and Korean (migration 009). |
| `vectorchord` | `boolean` | `false` | Replace the IVFFlat index with a VectorChord `vchordrq` index (migration 010). Requires `vchord` in `shared_preload_libraries` and a server restart. |
| `bm25` | `boolean` | `false` | Create pg_textsearch BM25 indexes (migrations 011 and 015). Requires `pg_textsearch` in `shared_preload_libraries` and a server restart. |
| `sqlDir` | `string` | The package's `sql/` directory | Directory holding the migration files. See [SQL directory](#sql-directory). |
| `embeddingDimensions` | `number` | `384` | Dimension of `rag_documents.embedding`, substituted for `__EMBEDDING_DIM__` in migration 002. |

::: warning
`embeddingDimensions` only affects a fresh install, because migration 002 runs once. Changing the dimension of an existing database needs a manual `ALTER TABLE` and re-embedding of every row. One database has one dimension for all tenants.
:::

The extensions themselves (pgvector, pg_trgm and the optional ones) must be installed on the server. See [Prepare Postgres](/how-to/prepare-postgres).

## Migration list

"Always" means the file is applied regardless of options.

| File | Applies | What it does |
|------|---------|--------------|
| `001_extensions.sql` | Always | `CREATE EXTENSION IF NOT EXISTS vector` and `pg_trgm`. |
| `002_rag_documents.sql` | Always | Creates `rag_documents` (with `embedding vector(__EMBEDDING_DIM__)` and the since-dropped `content_stemmed` column) and the B-tree index `idx_rag_tenant (tenant_id)`. |
| `003_hybrid_indexes.sql` | Always | Creates `idx_rag_content_trgm` (GIN `gin_trgm_ops` on `content`; dropped by 013) and `idx_rag_embedding_ivfflat` (IVFFlat, `vector_cosine_ops`, `lists = 100`). |
| `004_tsvector_trigger.sql` | Always | Adds `content_tsvector`, the trigger function `rag_documents_tsvector_trigger()` and trigger `trg_rag_documents_tsvector` (BEFORE INSERT OR UPDATE), the GIN index `idx_rag_content_fts`, and backfills existing rows. Initially uses the `simple` configuration. |
| `005_stop_words.sql` | Always | Creates `rag_stop_words` and `idx_rag_stop_words_tenant`. |
| `006_synonyms.sql` | Always | Creates `rag_synonyms`, `idx_rag_synonyms_tenant`, and the unique index `idx_rag_synonyms_tenant_term_lang (tenant_id, term, language)`. |
| `007_rls_policies.sql` | `rls` | Enables row-level security and creates tenant-isolation policies on `rag_documents`, `rag_stop_words` and `rag_synonyms`. |
| `008_postgres_stemming.sql` | Always | Creates `rag_fts_config(lang)` (seven languages), switches the trigger to `to_tsvector(rag_fts_config(NEW.language), NEW.content)`, and rebuilds `content_tsvector` for every row. |
| `009_cjk_bigm.sql` | `cjk` | `CREATE EXTENSION IF NOT EXISTS pg_bigm` and the GIN index `idx_rag_content_bigm` (`gin_bigm_ops` on `content`). |
| `010_vectorchord.sql` | `vectorchord` | `CREATE EXTENSION IF NOT EXISTS vchord CASCADE`, drops `idx_rag_embedding_ivfflat`, creates `idx_rag_embedding_vchordrq` (`vchordrq`, `vector_cosine_ops`). |
| `011_pg_textsearch.sql` | `bm25` | `CREATE EXTENSION IF NOT EXISTS pg_textsearch` and eight partial BM25 indexes on `content` (one per language group plus a `simple` catch-all). |
| `012_drop_dead_index.sql` | Always | Drops `idx_rag_content_stemmed_trgm` (if present) and the unused `content_stemmed` column. |
| `013_normalization.sql` | Always | Adds `content_normalized`, sets it to `content` where null, creates `idx_rag_content_normalized_trgm` (GIN `gin_trgm_ops`), and drops `idx_rag_content_trgm`. |
| `014_arabic_fts.sql` | Always | Replaces `rag_fts_config` to add Arabic, switches the trigger to read `COALESCE(content_normalized, content)`, and rebuilds `content_tsvector` for every row. |
| `015_bm25_normalized_textsearch.sql` | `bm25` | Drops and recreates the eight BM25 indexes on `content_normalized` instead of `content`, with the same names, predicates and configurations. |
| `016_source_index.sql` | Always | Creates `idx_rag_source (tenant_id, source_type, source_id)` for source deletes and replaces. |
| `017_attributes.sql` | Always | Adds `attributes JSONB NOT NULL DEFAULT '[]'` and the GIN index `idx_rag_attributes` (`jsonb_path_ops`). Existing rows get `[]`; there is no backfill. |
| `018_metadata_registry.sql` | Always | Creates `rag_metadata_registry`. |
| `019_metadata_registry_rls.sql` | `rls` | Enables row-level security and a tenant-isolation policy on `rag_metadata_registry`. |
| `020_stop_words_unique.sql` | Always | Deletes duplicate `rag_stop_words` rows with the same `(tenant_id, language, word)`, keeping one row of each, then creates the unique index `idx_rag_stop_words_tenant_lang_word (tenant_id, language, word)`. Matching is exact and case-sensitive (`The` and `the` are distinct). |
| `021_force_rls.sql` | `rls` | Sets `FORCE ROW LEVEL SECURITY` on `rag_documents`, `rag_stop_words`, `rag_synonyms` and `rag_metadata_registry`, so the tenant policies also apply to the table owner. Superusers and roles with `BYPASSRLS` remain exempt. |

Notes:

- Migrations 008, 013 and 014 each run an `UPDATE` over every row of `rag_documents` (013 only where `content_normalized` is null, which is every row on first run); on a large existing table this takes time and rewrites each row.
- Migrations 013 and 016 create indexes inside the migration. On a large existing table, you can build the same index first with `CREATE INDEX CONCURRENTLY` and the same name; the migration's `IF NOT EXISTS` then skips it. For 013, the `content_normalized` column must exist first: add it with `ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS content_normalized TEXT` before building the index (the migration's `ADD COLUMN IF NOT EXISTS` then skips it too).
- Migration 007 uses `CREATE POLICY` without `OR REPLACE`. A database that already recorded 007 keeps its existing policies.
- Migration 021 changes behavior for an application that connects as the (non-superuser) role that owns the tables: before 021 the owner bypassed the policies and saw every tenant's rows; after it, the owner must set `app.current_tenant_id`, and queries without it return no rows.
- After 021, a data migration (`UPDATE` or `DELETE` backfill) on these tables run by a non-superuser owner sees only the rows of the tenant in `app.current_tenant_id` (none when unset). The header of `sql/021_force_rls.sql` shows the pattern: record `pg_class.relforcerowsecurity`, run `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`, run the backfill, and restore `FORCE` only if it was set, all in one `DO` block.
- The resulting tables, columns, indexes and functions are listed in [Schema](/reference/schema).

## Related

- [Run migrations](/how-to/run-migrations)
- [Prepare Postgres](/how-to/prepare-postgres)
- [Schema](/reference/schema)
