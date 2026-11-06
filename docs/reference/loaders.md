# Stop-word and synonym loaders

`CachingStopWordsLoader` and `CachingSynonymLoader` read a tenant's stop words and synonyms from the database and cache them per tenant for 30 seconds. They implement [`StopWordsProvider`](/reference/interfaces) and [`SynonymProvider`](/reference/interfaces) for `RagPipeline`. This page covers their configuration, methods, the SQL they run, the row formats they accept, and synonym direction.

```ts
import { CachingStopWordsLoader, CachingSynonymLoader, RagPipeline } from "pg-hybrid-rag";

const stopWords = new CachingStopWordsLoader({ txProvider });
const synonyms = new CachingSynonymLoader({ txProvider });

const pipeline = new RagPipeline({ tenantId, db, embedder, stopWords, synonyms });
```

The tables are described on [Schema](/reference/schema). For adding rows, see [Stop words and synonyms](/how-to/stop-words-and-synonyms).

## Caching behavior

Both loaders share these rules:

- The cache is per tenant and per loader instance, in memory. The time to live is 30 seconds and is not configurable.
- Within 30 seconds of a successful load, `load()` returns the cached object without querying.
- After 30 seconds, the next `load()` waits for a fresh query. There is no background refresh.
- Concurrent `load()` calls for the same tenant while a query is running share that query.
- A failed load is not cached; the error propagates to the caller and the next call queries again.
- `invalidate(tenantId)` drops the tenant's cache entry and its in-flight record, so the next `load()` queries again. A query already running when `invalidate()` is called still stores its result when it finishes.
- Each load runs its query inside one `txProvider.withConnection()` call.
- Returned maps and sets are the cached objects. Treat them as read-only.

## CachingStopWordsLoader

<!-- no-check -->
```ts
new CachingStopWordsLoader(config: CachingStopWordsLoaderConfig)
```

### CachingStopWordsLoaderConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `txProvider` | `TransactionProvider` | required | Supplies the connection for each load. |
| `loadFn` | `(client: SqlClient, tenantId: string) => Promise<StopWordRow[]>` | queries `rag_stop_words` | Replaces the default query. Must return `{ language, word }` rows. |
| `normalizeWord` | `(word: string, language: string) => string` | none | Applied to each lowercased word at load time, for example `normalizeForLanguage`, so stop words match a normalized query. |

Default query:

```sql
SELECT language, word FROM rag_stop_words WHERE tenant_id = $1
```

Each word is lowercased, then passed to `normalizeWord` if set, and added to the set for its `language`.

### Methods

<!-- no-check -->
```ts
load(tenantId: string): Promise<Map<string, Set<string>>>
loadMerged(tenantId: string): Promise<Set<string>>
invalidate(tenantId: string): void
```

| Method | Returns |
|---|---|
| `load` | `language -> Set<word>`. |
| `loadMerged` | One set with the words of every language. Built from `load()`'s cached entry and memoized per entry, so it follows the same 30-second cache. `RagPipeline` calls this method. |
| `invalidate` | Drops the cached map and the merged set for the tenant. |

`RagPipeline` removes stop words from every language, not only the query language: a word listed for any language is removed from the lexical query. Matching compares each whitespace-separated query word, lowercased, with the set.

## CachingSynonymLoader

<!-- no-check -->
```ts
new CachingSynonymLoader(config: CachingSynonymLoaderConfig)
```

### CachingSynonymLoaderConfig

| Field | Type | Default | Description |
|---|---|---|---|
| `txProvider` | `TransactionProvider` | required | Supplies the connection for each load. |
| `loadFn` | `(client: SqlClient, tenantId: string) => Promise<SynonymRow[]>` | queries `rag_synonyms` | Replaces the default query. Must return `SynonymRow` objects. |

Default query:

```sql
SELECT language, term, synonyms, direction FROM rag_synonyms WHERE tenant_id = $1 ORDER BY language, term, synonyms
```

The `ORDER BY` makes the per-term cap below deterministic.

### Methods

<!-- no-check -->
```ts
load(tenantId: string): Promise<SynonymLookup>
invalidate(tenantId: string): void
```

`load` returns a `SynonymLookup`: `Map<language, Map<term, string[]>>`. `invalidate` drops the tenant's cached lookup.

### Row format

| `SynonymRow` field | Type | Description |
|---|---|---|
| `language` | `string` | Language code. The lookup is grouped by it. |
| `term` | `string` | Term or multi-word phrase. Lowercased. |
| `synonyms` | `string[]` or `string` | JSON array of strings. Accepted as a parsed array or as raw JSON text, depending on the driver. |
| `direction` | `"two_way"` or `"one_way"` | See below. |

Per-row handling:

- A `synonyms` string that is not valid JSON, or a value that is not an array (including `null`), skips that row only.
- Elements that are not strings are dropped; the rest are lowercased.
- A synonym equal to its own term is dropped, and duplicates are dropped.
- At most 5 synonyms are kept per term per language. Later rows for the same term add to the same list until the cap.

### Direction

| `direction` | Mappings added |
|---|---|
| `one_way` | `term -> synonyms` |
| `two_way` | `term -> synonyms`, and for each synonym, `synonym -> [term]` |

A `two_way` row does not map synonyms to each other. For a row `laptop` with `["notebook", "portable computer"]`:

```text
laptop            -> notebook, portable computer
notebook          -> laptop
portable computer -> laptop
```

Any value other than `"two_way"` is treated as one-way.

### How the lookup is used

The query builders merge the per-language maps into one map before expanding, so synonyms from every language apply to every query, with at most 5 expansions per term after merging. Multi-word terms are matched longest first. Lookup keys are only lowercased; the loader does not apply the pipeline's `normalizer` or `segmenter`, so store terms in the form the lexical query will have. Expansion happens in the FTS strategy only. See [FTS strategies](/reference/fts-strategies).

## Related

- [Stop words and synonyms](/how-to/stop-words-and-synonyms)
- [RagPipeline](/reference/rag-pipeline)
- [Schema](/reference/schema)
