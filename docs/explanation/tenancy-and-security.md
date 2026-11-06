# Tenancy, connections and security

This page explains how pg-hybrid-rag keeps tenants apart, what row-level security adds, why the library needs each `withConnection` call to pin one connection, why planner settings are transaction-local, and how SQL stays parameterized.

## A tenant id on everything

Every library data table has a `tenant_id` column: `rag_documents`, `rag_stop_words`, `rag_synonyms` and `rag_metadata_registry`. Every search, indexing, loader and catalog query the library issues filters on it.

The tenant is fixed at construction for the objects that act on behalf of one tenant. A `RagPipeline` or `RagIndexer` takes `tenantId` in its config, and every search or index call uses it. You cannot pass a different tenant per call by mistake, because there is no per-call tenant parameter. `PostgresRagDatabase` receives the tenant with each call, so one database adapter can serve many tenants. The caching loaders and the metadata catalog take the tenant as an argument and cache per tenant.

A typical service builds a pipeline per request, or caches one per tenant, and shares the database adapter, embedder and loaders across tenants.

## Row-level security as a second layer

The `WHERE tenant_id = $1` clauses are the first layer. They depend on the application passing the right tenant id. Row-level security (RLS) adds a check inside Postgres that holds even if application code is wrong.

`ragMigrate({ rls: true })` applies policies to the four tenant tables. Each policy allows a row only when its `tenant_id` equals the `app.current_tenant_id` setting:

```sql
USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
```

The second argument, `true`, makes `current_setting` return NULL instead of raising an error when the setting was never set. A NULL never equals a tenant id, so a connection that never set the tenant sees zero rows. On a pooled connection where an earlier transaction set the tenant and it has since been reset, the setting reads as an empty string instead, and the `::uuid` cast raises an error. Either way this is the fail-closed choice: a missing setting produces empty results or an error, not another tenant's data. The cost is that the mistake is quiet. A search that returns nothing, or a stop-word loader that loads nothing, can mean the tenant setting is missing.

Two Postgres rules decide whether the policies apply at all:

- **By default, Postgres exempts a table's owner from its own RLS policies.** Many applications connect as the same role that ran the migrations, and that role owns the tables. Without further action, such an application would see every tenant's rows, and RLS would protect nothing. With `rls: true`, migration 021 therefore sets `FORCE ROW LEVEL SECURITY` on the four tenant tables, which binds the owner to the policies like any other role. Superusers and roles with `BYPASSRLS` are still exempt; Postgres offers no way to bind them. Run the application as a role that is neither.
- **The policies have no separate `WITH CHECK` clause**, so Postgres applies the `USING` condition to inserted and updated rows too. With RLS on, the indexer can only write rows for the tenant in `app.current_tenant_id`.

Forcing RLS on the owner has two consequences. An application that connects as the owner without setting `app.current_tenant_id` now sees no rows, which is the same fail-closed behavior as any other role. And a data migration on these tables, run by a non-superuser owner, sees only the rows of the tenant in `app.current_tenant_id`. The header of `sql/021_force_rls.sql` shows the pattern such a migration uses: lift `FORCE` for its own transaction and restore it afterwards.

RLS needs the application to set `app.current_tenant_id` on the connection that runs each query, which leads to connection pinning.

## Why each `withConnection` must pin one connection

The library never opens connections itself. It calls your `TransactionProvider.withConnection(fn)` and runs queries through the `SqlClient` it is given. The contract is that every query inside one `fn` runs on the same database connection.

Several library operations are multi-statement sequences that only work on one session:

```text
one connection, one search leg:
  BEGIN
  SELECT set_config('pg_trgm.word_similarity_threshold', $1, true)
  SELECT ... FROM rag_documents WHERE tenant_id = $1 AND $2 <% content_normalized ...
  COMMIT
```

If a pool sent each statement to whichever connection was free, the `BEGIN` could open a transaction on one connection and leave it open, the setting could land on a second connection, and the `SELECT` could run on a third without the setting. The search would still return rows, but ranked with the wrong thresholds. Re-indexing (`DELETE` then `INSERT` in one transaction) and RLS (set the tenant, then query) have the same requirement.

The three search legs run concurrently, each in its own `withConnection` call, so one search holds up to three connections at once. Size your pool for that.

## Why planner settings are transaction-local

The vector and keyword legs tune Postgres for their queries: the trigram threshold, the pg_bigm candidate floor, the number of IVFFlat lists to probe, and optional iterative scan settings. `SET LOCAL` cannot take a bind parameter, so the library uses `set_config(name, value, true)`. The third argument makes the setting transaction-local: it ends at `COMMIT` or `ROLLBACK`.

This matters with a connection pool. A session-level `SET` would stay on the connection after the search finished, and the next borrower of that connection would silently inherit another request's threshold. Transaction-local settings cannot leak that way.

By default, `PostgresRagDatabase` wraps each tuned leg in its own `BEGIN` and `COMMIT` so that "local" has a transaction to be local to.

### When your connection is already in a transaction

The usual way to set the RLS tenant safely is the same idea: open a transaction, run `SET LOCAL app.current_tenant_id = ...` (or `set_config` with `true`), and run the work inside it. A `TransactionProvider` that does this hands the library a connection that is already in a transaction.

The library's own `BEGIN` would then be nested. Postgres warns about it, and the library's `COMMIT` would end your transaction early and discard your tenant setting. Construct the adapter with `manageTransaction: false` in that case. The library then issues no `BEGIN`, `COMMIT` or `ROLLBACK`. Its transaction-local settings attach to your transaction, and on an error it rethrows and leaves the rollback to you. Re-indexing follows the same rule: the delete and insert run in your transaction and stay atomic because your transaction is.

Setting the tenant with a session-level `SET` avoids the nesting problem, but it leaves the tenant id on the pooled connection for the next borrower. If that borrower forgets to set its own tenant, it reads the previous tenant's rows instead of none. The transaction-local form keeps the fail-closed behavior.

See [Isolate tenants with RLS](/how-to/multi-tenancy-rls) and [Connect your database driver](/how-to/connect-database-driver) for the setup.

## Parameterized SQL

User and caller input never becomes SQL text. Specifically:

- **Values are bound parameters.** Tenant ids, query text, embeddings, limits, thresholds and setting values all travel as `$n` parameters.
- **Only trusted constants are inlined.** A few things cannot be bound: setting names in `set_config`, the BM25 index name that `pg_textsearch` requires, and the language lists in the BM25 partial-index predicate. These come from constants in the library, never from input.
- **List filters are bound as one string.** `sourceTypes`, `sourceIds` and `languages` are joined with commas, bound as one parameter, and split in SQL with `string_to_array`. This works the same with every driver. A value that contains a comma would be split wrongly, so the library rejects it with an error instead.
- **Attribute filters are bound as JSON text.** Containment tests bind a JSON string and cast it with `::text::jsonb`. The double cast avoids a driver behavior where a string bound directly to a `jsonb` parameter is encoded a second time and matches nothing.
- **Full-text query syntax is sanitized.** `to_tsquery` parses operators inside its input even when that input is a bound parameter. The library strips operator characters from each term before it builds input for `to_tsquery`, and uses `plainto_tsquery`, which ignores operator syntax, when the query needs no operators. A query therefore cannot inject `tsquery` syntax or make the full-text query invalid.

### Bounded filters

Filters can come from a user interface or from a language model, so their size is bounded. Validation rejects filters deeper than 5 levels, with more than 32 conditions, lists longer than 50 values, or strings longer than 256 characters. These limits keep any single filter's SQL small, whoever wrote it. `search` validates with these defaults unless you set `filterLimits` on the `RagPipeline`, which overrides them for both your explicit filter and a generated filter. `validateFilter` accepts a `limits` option if you pre-validate filters yourself.

## Failure behavior

Security-relevant failures are designed to stop the search rather than return something that looks normal:

- If any search leg fails, the whole search fails with an `AggregateError` that names each failed leg. The library waits for every leg to settle first, so no query is left running on a connection you are about to release.
- A filter that the database or FTS strategy cannot apply throws `AttributeFiltersUnsupportedError` instead of running unfiltered.
- An RLS-protected query on a connection without a tenant setting sees no rows, or fails with a `uuid` cast error if the setting was set and then reset on that pooled connection.

Two components degrade instead of failing, by design, because they affect ranking, not access: a failing reranker falls back to fused results, and a failing filter model is dropped (your explicit filter still applies).

## Related

- [Isolate tenants with RLS](/how-to/multi-tenancy-rls)
- [Connect your database driver](/how-to/connect-database-driver)
- [Interfaces reference](/reference/interfaces)
- [Schema reference](/reference/schema)
