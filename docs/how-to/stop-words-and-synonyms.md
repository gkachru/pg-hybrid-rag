# Manage stop words and synonyms

Stop words are removed from the query before the keyword and full-text legs run. Synonyms expand the full-text query so that, for example, a search for "laptop" also matches "notebook". Both are stored per tenant in PostgreSQL and loaded through caching loaders. This guide covers adding rows, wiring the loaders, and refreshing the cache.

## Before you begin

- Migrations have run (tables `rag_stop_words` and `rag_synonyms` come from migrations 005 and 006; migration 020 adds the unique index on stop words).
- Under row-level security, insert rows in a transaction that sets `app.current_tenant_id`. Once migration 021 has run, this applies to the owner role too; only superusers and `BYPASSRLS` roles skip the policies. See [Isolate tenants with RLS](/how-to/multi-tenancy-rls).

## Steps

### 1. Add stop words

```sql
INSERT INTO rag_stop_words (tenant_id, language, word) VALUES
  ('11111111-1111-1111-1111-111111111111', 'en', 'the'),
  ('11111111-1111-1111-1111-111111111111', 'en', 'how'),
  ('11111111-1111-1111-1111-111111111111', 'es', 'el'),
  ('11111111-1111-1111-1111-111111111111', 'es', 'cómo')
ON CONFLICT DO NOTHING;
```

Each `(tenant_id, language, word)` is unique (migration 020), so `ON CONFLICT DO NOTHING` lets you re-run a seed script; without it, inserting an existing row fails. The comparison is exact: `The` and `the` are separate rows, and the loader lowercases both to the same word.

### 2. Add synonyms

```sql
INSERT INTO rag_synonyms (tenant_id, language, term, synonyms, direction) VALUES
  ('11111111-1111-1111-1111-111111111111', 'en', 'laptop', '["notebook"]', 'two_way'),
  ('11111111-1111-1111-1111-111111111111', 'en', 'tv', '["television"]', 'one_way'),
  ('11111111-1111-1111-1111-111111111111', 'en', 'phone', '["smartphone", "mobile phone"]', 'two_way')
ON CONFLICT (tenant_id, term, language)
DO UPDATE SET synonyms = EXCLUDED.synonyms,
              direction = EXCLUDED.direction,
              updated_at = NOW();
```

| Column | Value |
| --- | --- |
| `term` | The word or phrase to expand. Multi-word terms match as a phrase. Unique per tenant and language. |
| `synonyms` | A JSON array of strings. Multi-word entries are allowed. |
| `direction` | `two_way` (default): `term` expands to each synonym, and each synonym expands to `term`. `one_way`: only `term` expands. |

In the example, "laptop" and "notebook" find each other, "tv" also matches "television" but not the reverse.

### 3. Wire the loaders into the pipeline

```ts
import {
  CachingStopWordsLoader,
  CachingSynonymLoader,
  RagPipeline,
} from "pg-hybrid-rag";

const stopWords = new CachingStopWordsLoader({ txProvider });
const synonyms = new CachingSynonymLoader({ txProvider });

const pipeline = new RagPipeline({ tenantId, db, embedder, stopWords, synonyms });
```

Both are optional. Without them, search runs with no stop-word removal and no synonym expansion.

### 4. Refresh after changes

Each loader caches a tenant's rows for 30 seconds. After you change rows, call `invalidate` on the same loader instances the pipeline uses, so the next search reloads them:

```ts
import type { CachingStopWordsLoader, CachingSynonymLoader } from "pg-hybrid-rag";

declare const stopWords: CachingStopWordsLoader;
declare const synonyms: CachingSynonymLoader;

stopWords.invalidate(tenantId);
synonyms.invalidate(tenantId);
```

If a load for that tenant is already in flight when you call `invalidate`, the searches waiting on it still get its result, but the result isn't cached; the next search reads the tables again.

Each process has its own cache. In a deployment with several instances, the others pick up the change when their cache expires, within 30 seconds.

## How they apply to a query

- **Lowercasing.** The loaders lowercase stop words, terms and synonyms, and the pipeline lowercases the query, so matching is case-insensitive.
- **Stop words from every language apply to every query.** The pipeline merges all of a tenant's stop words, whatever their `language`, and removes them from the query regardless of the search `language`. Avoid a stop word in one language that is a meaningful word in another language you search.
- **Stop words affect only the lexical legs.** The keyword and full-text legs get the reduced query; the embedding and the reranker get the full query. If every word is a stop word, the lexical legs use the query without removing any.
- **Synonyms affect only the full-text leg.** They are added to the `tsquery` (or the BM25 query). The keyword and vector legs don't see them.
- **Synonyms from every language apply to every query**, the same as stop words.
- **At most five synonyms per term are kept.** Rows load in order of `language`, `term`, `synonyms`, so the cut is deterministic.
- **A malformed `synonyms` value skips that row** (for example, a value that isn't a JSON array). The other rows still load.

### Match the query's normalized form

Matching happens after the pipeline's `normalizer` and `segmenter` run on the query. If you use one, store words in the form it produces. `CachingStopWordsLoader` can apply the same normalization when it loads, through `normalizeWord`:

```ts
import { CachingStopWordsLoader, normalizeForLanguage } from "pg-hybrid-rag";

const stopWords = new CachingStopWordsLoader({
  txProvider,
  normalizeWord: (word, language) => normalizeForLanguage(word, language),
});
```

`CachingSynonymLoader` has no equivalent option, so store synonym terms already normalized.

## Load from your own tables

If you keep stop words or synonyms elsewhere, pass a `loadFn` that returns rows in the expected shape:

```ts
import { CachingSynonymLoader, type SynonymRow } from "pg-hybrid-rag";

const synonyms = new CachingSynonymLoader({
  txProvider,
  loadFn: (client, tenantId) =>
    client.query<SynonymRow>(
      `SELECT lang AS language, word AS term, alternatives AS synonyms, 'two_way' AS direction
       FROM shop_search_synonyms WHERE tenant_id = $1 ORDER BY lang, word`,
      [tenantId],
    ),
});
```

`synonyms` may be a parsed array or a JSON string; the loader accepts either. For stop words, return `{ language, word }` rows (`StopWordRow`).

## Related

- [Isolate tenants with RLS](/how-to/multi-tenancy-rls)
- [Search multilingual content](/how-to/multilingual-search)
- [Tune relevance](/how-to/tune-relevance)
- [Stop word and synonym loaders reference](/reference/loaders)
- [Language processing](/explanation/language-processing)
