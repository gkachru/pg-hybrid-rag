# Connect your database driver

The library owns no database connections. You give it a `TransactionProvider` (and, for some calls, a `SqlClient`) built on the driver you already use. This guide shows working providers for postgres.js, node-postgres and Prisma, and how to set `manageTransaction` to match.

## The contract

```ts
import type { SqlClient, TransactionProvider } from "pg-hybrid-rag";

// SqlClient: run one parameterized statement ($1, $2, ...) and return its rows.
// TransactionProvider: run `fn` with a SqlClient whose queries ALL go to one connection.
declare const client: SqlClient;
declare const provider: TransactionProvider;
```

Two rules matter:

1. **`withConnection` must pin one connection for the whole callback.** The vector and keyword legs run `BEGIN`, then `set_config(..., true)` for planner settings such as `ivfflat.probes`, then the `SELECT`, then `COMMIT`. Re-indexing (`replaceSource`) runs `DELETE` and `INSERT` in one transaction. If each query can land on a different pooled connection, the settings never reach the search query and re-indexing loses its atomicity.
2. **Tell the adapter who owns the transaction.** If your `withConnection` only pins a connection, keep the default `manageTransaction: true` and the adapter issues its own `BEGIN`/`COMMIT`/`ROLLBACK`. If your `withConnection` already runs the callback inside a transaction, construct the adapter with `manageTransaction: false`.

| Your `withConnection` | Example | `manageTransaction` |
| --- | --- | --- |
| Reserves a connection, no transaction | postgres.js `sql.reserve()`, node-postgres `pool.connect()` | `true` (default) |
| Opens a transaction around the callback | postgres.js `sql.begin()`, Prisma `$transaction()` | `false` |

With `manageTransaction: false`, the adapter runs `set_config(..., true)` and its statements inside your transaction, never issues `BEGIN`, `COMMIT` or `ROLLBACK`, and rethrows errors so your transaction rolls back.

## postgres.js: reserve a connection

```ts
import postgres from "postgres";
import { PostgresRagDatabase, type SqlClient, type TransactionProvider } from "pg-hybrid-rag";

const sql = postgres("postgres://app:change-me@localhost:5432/app", {
  max: 10,
  onnotice: () => {}, // or forward notices to your logger
});

function toSqlClient(conn: Pick<postgres.Sql, "unsafe">): SqlClient {
  return {
    async query<T = Record<string, unknown>>(text: string, params: unknown[]): Promise<T[]> {
      const rows = await conn.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
  };
}

const txProvider: TransactionProvider = {
  async withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    const reserved = await sql.reserve();
    try {
      return await fn(toSqlClient(reserved));
    } finally {
      reserved.release();
    }
  },
};

const db = new PostgresRagDatabase(txProvider); // manageTransaction defaults to true
```

postgres.js prints server `NOTICE` messages to the console by default. Migrations produce several, such as `relation "_rag_migrations" already exists, skipping` on every run after the first, so pass `onnotice` to silence them or route them to your logger.

postgres.js rejects a raw `BEGIN` on an unreserved connection from a pool with `max` above 1 (`UNSAFE_TRANSACTION`), so a provider that calls `sql.unsafe` directly fails on the first search.

## postgres.js: run inside a transaction

Use this form when you need transaction-local settings of your own, such as the tenant setting for row-level security.

```ts
import postgres from "postgres";
import { PostgresRagDatabase, type SqlClient, type TransactionProvider } from "pg-hybrid-rag";

declare const sql: postgres.Sql;
declare function toSqlClient(conn: Pick<postgres.Sql, "unsafe">): SqlClient;

const txProvider: TransactionProvider = {
  async withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    const result = await sql.begin((tx) => fn(toSqlClient(tx)));
    return result as T;
  },
};

const db = new PostgresRagDatabase(txProvider, { manageTransaction: false });
```

See [Isolate tenants with RLS](/how-to/multi-tenancy-rls) for the version that sets `app.current_tenant_id`.

## node-postgres (pg)

`pool.connect()` checks out one client and keeps it until `release()`, without opening a transaction, so keep the default `manageTransaction`.

<!-- no-check -->
```ts
import pg from "pg";
import { PostgresRagDatabase, type TransactionProvider } from "pg-hybrid-rag";

const pool = new pg.Pool({ connectionString: "postgres://app:change-me@localhost:5432/app" });

const txProvider: TransactionProvider = {
  async withConnection(fn) {
    const client = await pool.connect();
    try {
      return await fn({
        query: async (text, params) => (await client.query(text, params)).rows,
      });
    } finally {
      client.release();
    }
  },
};

const db = new PostgresRagDatabase(txProvider);
```

## Prisma

A top-level `prisma.$queryRawUnsafe` call can run on any pooled connection, so it does not pin. Use an interactive transaction and the `tx` client it passes you. Because `$transaction` opens a transaction, set `manageTransaction: false`.

<!-- no-check -->
```ts
import { PrismaClient } from "@prisma/client";
import { PostgresRagDatabase, type TransactionProvider } from "pg-hybrid-rag";

const prisma = new PrismaClient();

const txProvider: TransactionProvider = {
  withConnection: (fn) =>
    prisma.$transaction(
      (tx) => fn({ query: (text, params) => tx.$queryRawUnsafe(text, ...params) }),
      { timeout: 15_000 },
    ),
};

const db = new PostgresRagDatabase(txProvider, { manageTransaction: false });
```

Prisma ends an interactive transaction after its `timeout` (5 seconds unless you set it). Set it above your slowest search or re-index call.

## Size the pool

`PostgresRagDatabase.hybridSearch` runs its three legs in parallel, each in its own `withConnection` call. One search therefore holds up to three connections at once. Size the pool for three times the number of searches you expect to run concurrently, plus indexing and other application traffic.

## Choose a provider for migrations and loaders

- **`ragMigrate`** issues its own `BEGIN`/`COMMIT` per migration file when you pass a `TransactionProvider`. Give it a pin-only provider (the `sql.reserve()` or `pool.connect()` form), not one that already opens a transaction. See [Run migrations](/how-to/run-migrations).
- **`CachingStopWordsLoader`, `CachingSynonymLoader` and `CachingMetadataCatalog`** don't issue `BEGIN` or `COMMIT` and don't need a transaction, so either provider form works. Under row-level security, their provider must set the same tenant they load.

## Check that pinning works

If pinning is broken, searches still return results, so the problem is easy to miss. Signs to look for:

- Server log warnings such as `there is no transaction in progress` or `there is already a transaction in progress`.
- Lower vector recall than expected, because `ivfflat.probes` falls back to the server default of 1.

A nested `BEGIN` (an interactive-transaction provider with `manageTransaction` left at `true`) produces the second warning, and the inner `COMMIT` ends your transaction early, discarding any `SET LOCAL` you made.

## Related

- [Isolate tenants with RLS](/how-to/multi-tenancy-rls)
- [Run migrations](/how-to/run-migrations)
- [PostgresRagDatabase reference](/reference/postgres-rag-database)
- [Interfaces reference](/reference/interfaces)
- [Tenancy and security](/explanation/tenancy-and-security)
