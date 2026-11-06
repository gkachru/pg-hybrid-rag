# Tune the vector index

This guide covers the approximate vector index behind the vector leg: rebuilding and sizing the default IVFFlat index, setting probes, turning on iterative scans for selective filters, and switching to a VectorChord `vchordrq` index.

For how the planner chooses between the vector index and other plans, see [Indexes and performance](/explanation/indexes-and-performance).

## Before you begin

- Use pgvector 0.8.7 or later. pgvector 0.8.6 and earlier have an IVFFlat index-build buffer overflow ([pgvector#1036](https://github.com/pgvector/pgvector/issues/1036)).
- Make sure your `TransactionProvider` pins one connection per `withConnection` call. The adapter applies the vector settings below transaction-locally, and they are lost if the search query runs on another connection. See [Connect your database driver](/how-to/connect-database-driver).

## Rebuild the IVFFlat index after loading data

Migration 003 creates `idx_rag_embedding_ivfflat` with `lists = 100`. IVFFlat computes its list centroids from the rows present when the index is built, and `ragMigrate` usually runs on an empty table. After your first bulk load, and after large changes to the corpus, rebuild it:

```sql
REINDEX INDEX CONCURRENTLY idx_rag_embedding_ivfflat;
```

To change the number of lists, recreate the index under the same name (migration 010 drops it by that name if you later switch to VectorChord):

```sql
DROP INDEX IF EXISTS idx_rag_embedding_ivfflat;
CREATE INDEX idx_rag_embedding_ivfflat
  ON rag_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 1000);
```

A common starting point is `lists` ≈ rows / 1000 up to about 1 million rows, and ≈ √rows above that.

## Set probes

`ivfflatProbes` sets how many lists each vector search scans. The adapter default is `10`; pgvector's own default is `1`, which gives poor recall. More probes raise recall and latency. pgvector suggests √`lists` as a starting point.

```ts
import { PostgresRagDatabase } from "pg-hybrid-rag";

const db = new PostgresRagDatabase(txProvider, { ivfflatProbes: 32 }); // e.g. lists = 1000
```

The value must be a positive integer. The constructor throws `ivfflatProbes must be a positive integer (got X)` for `0`, a negative number, a fraction or `NaN`.

## Turn on iterative scans for selective filters

The vector leg filters by tenant, and by `sourceTypes`, `sourceIds`, `languages` and attribute filters when you pass them. An approximate scan applies those filters after it has picked candidates, so a selective filter can leave the leg with fewer rows than it asked for. An iterative scan keeps probing more lists until enough rows pass.

```ts
import { PostgresRagDatabase } from "pg-hybrid-rag";

const db = new PostgresRagDatabase(txProvider, {
  ivfflatProbes: 10,
  ivfflatIterativeScan: "relaxed_order",
  ivfflatMaxProbes: 80, // default with iterative scan on: 4 × ivfflatProbes
});
```

| Option | Default | Effect |
| --- | --- | --- |
| `ivfflatIterativeScan` | `"off"` | `"relaxed_order"` turns on pgvector iterative scans (pgvector 0.8 or later). The adapter re-sorts the rows. Any other value, including `"strict_order"`, throws in the constructor. |
| `ivfflatMaxProbes` | `4 × ivfflatProbes` | Upper bound on lists scanned during an iterative scan, so a filter that matches nothing does not scan the whole index. Must be a positive integer. Applied only when iterative scan is on. |

If a very selective filter still returns too few rows, raise `ivfflatMaxProbes`.

## Check which plan the vector leg uses

The planner does not always use the vector index. For a tenant that owns a small share of the table, it may filter by the tenant index and sort those rows exactly, which ignores probes entirely. Run `EXPLAIN` on the vector leg's SQL with your real tenant and filters to see the plan. The SQL is in [`src/adapters/PostgresRagDatabase.ts`](https://github.com/gkachru/pg-hybrid-rag/blob/main/src/adapters/PostgresRagDatabase.ts), and the repository's index-utilization tests under [`tests/integration`](https://github.com/gkachru/pg-hybrid-rag/tree/main/tests/integration) show how to capture it.

## Switch to VectorChord

VectorChord's `vchordrq` index replaces IVFFlat. Queries do not change: the vector leg uses the same `<=>` cosine operator.

1. Install VectorChord, add `vchord` to `shared_preload_libraries`, and restart. See [Prepare PostgreSQL](/how-to/prepare-postgres).
2. Apply the migration. It drops `idx_rag_embedding_ivfflat` and builds `idx_rag_embedding_vchordrq`. Writes to the table are blocked while the index builds, so on a populated table run it in a maintenance window.

   ```ts
   import { ragMigrate, type TransactionProvider } from "pg-hybrid-rag";

   // Both come from "Run migrations": the package's sql/ directory and a pinned,
   // non-transactional provider connected as the schema owner.
   declare const sqlDir: string;
   declare const migrationProvider: TransactionProvider;

   // Pass the same flags you used before, plus this one.
   await ragMigrate(migrationProvider, { sqlDir, vectorchord: true });
   ```

   Passing `sqlDir` works in every version; 0.2.5 and earlier require it when the library is installed as a package. See [Run migrations](/how-to/run-migrations).

3. Keep your adapter code. The `ivfflatProbes`, `ivfflatIterativeScan` and `ivfflatMaxProbes` options have no effect on a `vchordrq` index.

The migration builds the index without IVF partitions, so every query scans all quantized vectors and latency grows with the corpus. For a large corpus, build a partitioned index and set `vchordrq.probes`. The adapter does not set VectorChord settings, so set the probes at the database or role level. The syntax below follows the VectorChord documentation; check it against the version you run, and measure latency and recall on your own data before and after.

```sql
DROP INDEX IF EXISTS idx_rag_embedding_vchordrq;
CREATE INDEX idx_rag_embedding_vchordrq ON rag_documents
  USING vchordrq (embedding vector_cosine_ops) WITH (options = $$
[build.internal]
lists = [1000]
$$);

ALTER DATABASE your_db SET vchordrq.probes = '10';  -- only with lists; leave unset for an unpartitioned index
```

::: warning Upgrading VectorChord
The `vchordrq` on-disk format can change between releases, for example from 0.4.x to 1.x. After you replace the binaries, inserts and vector searches fail until the index is rebuilt. Run `ALTER EXTENSION vchord UPDATE;` and then `REINDEX INDEX idx_rag_embedding_vchordrq;` (the error message asks for a REINDEX; a plain REINDEX blocks writes to the table while it runs), or drop the index before the upgrade and recreate it after.
:::

## Related

- [Prepare PostgreSQL](/how-to/prepare-postgres)
- [Filter search results by metadata](/how-to/filter-by-metadata)
- [PostgresRagDatabase reference](/reference/postgres-rag-database)
- [Migrations reference](/reference/migrations)
- [Indexes and performance](/explanation/indexes-and-performance)
