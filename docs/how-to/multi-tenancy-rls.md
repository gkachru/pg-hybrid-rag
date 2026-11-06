# Isolate tenants with RLS

Every table the library manages has a `tenant_id` column, and every query it issues filters on it. This guide adds PostgreSQL row-level security (RLS) on top, so the database itself rejects cross-tenant reads and writes, and explains which mistakes fail closed and which don't.

## Before you begin

- Tenant IDs are UUIDs. `tenant_id` is a `UUID` column, so the `tenantId` you pass to `RagPipeline`, `RagIndexer` and the loaders must be a valid UUID string. With one database per tenant, use a fixed UUID constant.
- A provider that pins one connection per call. See [Connect your database driver](/how-to/connect-database-driver).
- Two database roles: an owner role that runs migrations, and an application role that is not the owner, not a superuser, and doesn't have `BYPASSRLS`. A separate application role is recommended; the owner can alter or drop the policies.

## Steps

### 1. Apply the RLS migrations as the owner

```ts
import { ragMigrate, type TransactionProvider } from "pg-hybrid-rag";

declare const ownerProvider: TransactionProvider; // connects as the owner role
declare const sqlDir: string; // the package's sql/ directory; see "Run migrations"

await ragMigrate(ownerProvider, { sqlDir, rls: true, embeddingDimensions: 1024 });
```

`rls: true` enables RLS, creates one policy per table, and then forces the policies on the table owner:

| Table | Migration |
| --- | --- |
| `rag_documents`, `rag_stop_words`, `rag_synonyms` | 007 |
| `rag_metadata_registry` | 019 |
| All four tables: `FORCE ROW LEVEL SECURITY` | 021 |
| All four policies recreated to treat an empty setting as unset | 022 |

Each policy is `USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)` (the `NULLIF` form is from migration 022). It has no separate `WITH CHECK`, so the same condition also applies to inserted and updated rows.

### 2. Create the application role

Superusers and roles with `BYPASSRLS` ignore the policies. After migration 021 the table owner is bound by them like any other role, but it can still alter or drop them, so connect the application as a separate role:

```sql
CREATE ROLE rag_app LOGIN PASSWORD 'change-me' NOSUPERUSER NOBYPASSRLS;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON rag_documents, rag_stop_words, rag_synonyms, rag_metadata_registry
  TO rag_app;
```

Tables added by future migrations need the same grant. Either grant again after each upgrade, or set default privileges for the owner role (here named `rag_owner`):

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE rag_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rag_app;
```

### 3. Set the tenant per transaction

Write a provider that opens a transaction, sets `app.current_tenant_id` with `set_config(..., true)` (transaction-local, the same as `SET LOCAL`), and runs the callback inside it. Because the provider owns the transaction, construct the adapter with `manageTransaction: false`.

```ts
import postgres from "postgres";
import { PostgresRagDatabase, type SqlClient, type TransactionProvider } from "pg-hybrid-rag";

// Connect as the application role.
const sql = postgres("postgres://rag_app:change-me@localhost:5432/app", { max: 20, onnotice: () => {} });

function toSqlClient(conn: Pick<postgres.Sql, "unsafe">): SqlClient {
  return {
    async query<T = Record<string, unknown>>(text: string, params: unknown[]): Promise<T[]> {
      const rows = await conn.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
  };
}

function tenantProvider(tenantId: string): TransactionProvider {
  return {
    async withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
      const result = await sql.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
        return fn(toSqlClient(tx));
      });
      return result as T;
    },
  };
}

const db = new PostgresRagDatabase(tenantProvider(tenantId), { manageTransaction: false });
```

The setting ends with the transaction, so it can't leak to the next request that borrows the connection. Each of the three search legs runs in its own `withConnection` call and sets the tenant for itself.

### 4. Build one set of objects per tenant

`RagPipeline` and `RagIndexer` take a fixed `tenantId`, and the provider sets the session to that same tenant. Build them together and reuse them. The loaders keep a 30-second cache per instance, so creating new loaders on every request discards that cache.

```ts
import {
  CachingStopWordsLoader,
  CachingSynonymLoader,
  PostgresRagDatabase,
  RagIndexer,
  RagPipeline,
  type TransactionProvider,
} from "pg-hybrid-rag";

declare function tenantProvider(tenantId: string): TransactionProvider;

const tenants = new Map<string, { pipeline: RagPipeline; indexer: RagIndexer }>();

function forTenant(id: string) {
  let entry = tenants.get(id);
  if (!entry) {
    const txProvider = tenantProvider(id);
    const db = new PostgresRagDatabase(txProvider, { manageTransaction: false });
    entry = {
      pipeline: new RagPipeline({
        tenantId: id,
        db,
        embedder,
        stopWords: new CachingStopWordsLoader({ txProvider }),
        synonyms: new CachingSynonymLoader({ txProvider }),
      }),
      indexer: new RagIndexer({ tenantId: id, db, embedder }),
    };
    tenants.set(id, entry);
  }
  return entry;
}

const results = await forTenant(tenantId).pipeline.search(query, { language: "en" });
```

The same applies to `CachingMetadataCatalog`: its provider must set the tenant it describes, or it returns an empty catalog.

### 5. Verify isolation

Connect as the application role and check both cases:

```sql
-- Setting never set in this session: expect 0.
SELECT count(*) FROM rag_documents;

BEGIN;
SELECT set_config('app.current_tenant_id', '11111111-1111-1111-1111-111111111111', true);
-- Expect only this tenant's rows, even when asking for another tenant.
SELECT count(*) FROM rag_documents
WHERE tenant_id = '22222222-2222-2222-2222-222222222222';  -- expect 0
COMMIT;
```

Also confirm the role can't bypass the policies:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'rag_app';  -- both false
```

## What fails closed

| Situation | Result |
| --- | --- |
| `app.current_tenant_id` was never set in the session | Reads return zero rows. Inserts fail with a row-level security error. |
| The setting was set earlier on this pooled session and isn't set now (a finished transaction used `set_config(..., true)`, or the value was `RESET`), and this transaction skips setting it | The setting reads as an empty string. With migration 022 the policies treat it like an unset setting: reads return zero rows. On a database without 022, the `::uuid` cast raises `invalid input syntax for type uuid` and the query fails. |
| The session tenant differs from the `tenantId` argument | Reads return zero rows. Inserts and tenant changes fail with a row-level security error. |
| The application connects as the table owner | Same as any other role once migration 021 is applied: without the setting, reads return zero rows. On a database without 021, the owner skips the policies. |
| The application connects as a superuser or a `BYPASSRLS` role | **Not fail-closed.** Policies are skipped; only the library's own `tenant_id` filters apply. |

::: warning
Avoid session-level `SET app.current_tenant_id` (or `set_config(..., false)`) on pooled connections. If a code path skips the `RESET`, the next request on that connection runs as the previous tenant. Transaction-local settings avoid this.
:::

## Upgrade notes for older databases

### Migration 021 binds the owner

On a database already migrated with `rls: true`, the next `ragMigrate` run with `rls: true` applies migration 021. From then on, a non-superuser owner role sees only the rows of the tenant in `app.current_tenant_id`, and no rows when it is unset. Before you upgrade, check every process that connects as the owner:

- An application that connects as the owner must set `app.current_tenant_id` in each transaction, as in step 3, or it reads no rows.
- Scripts that work across tenants as the owner, such as bulk seeding or backfills, must set the tenant for each tenant they touch, or run as a superuser or `BYPASSRLS` role.

The header of `sql/021_force_rls.sql` shows the pattern a data migration uses to lift `FORCE` for its own transaction.

### Migration 022 recreates the policies

Migration 022 drops and recreates the four tenant policies by name in the `NULLIF` form. Running `ragMigrate` with `rls: true` applies it, which also upgrades a database that still has the one-argument policies from an early version of migration 007 (those raise `unrecognized configuration parameter` when the setting was never set). If you replaced a policy with your own under one of these names, re-apply your version after migration 022.

## Without RLS

RLS is optional. Without it, isolation rests on the `tenant_id = $1` condition that every library query includes. That covers the library's own queries, but not other code that reads these tables.

## Related

- [Connect your database driver](/how-to/connect-database-driver)
- [Run migrations](/how-to/run-migrations)
- [Manage stop words and synonyms](/how-to/stop-words-and-synonyms)
- [Schema reference](/reference/schema)
- [Tenancy and security](/explanation/tenancy-and-security)
