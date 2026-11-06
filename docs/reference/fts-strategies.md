# FTS strategies

The full-text leg of `PostgresRagDatabase` is pluggable. An `FtsStrategy` builds its own query form and runs its own SQL. The library ships two: `TsvectorFts` (the default, Postgres `tsvector`/`tsquery`) and `Bm25Fts` (BM25 ranking with the pg_textsearch extension). This page covers the contract and both implementations.

```ts
import { Bm25Fts, PostgresRagDatabase, TsvectorFts } from "pg-hybrid-rag";

const tsvectorDb = new PostgresRagDatabase(txProvider); // same as { fts: new TsvectorFts() }
const bm25Db = new PostgresRagDatabase(txProvider, { fts: new Bm25Fts() });
```

## FtsStrategy contract

<!-- no-check -->
```ts
interface FtsStrategy {
  readonly supportsAttributeFilters?: boolean;
  search(client: SqlClient, ctx: FtsContext): Promise<RankedCandidate[]>;
}
```

| Member | Description |
|---|---|
| `supportsAttributeFilters` | Set to `true` only when `search` applies `ctx.attributeFilter`. When absent or `false`, `PostgresRagDatabase.supportsAttributeFilters` is `false` and filtered searches throw `AttributeFiltersUnsupportedError`. |
| `search(client, ctx)` | Runs the FTS leg on `client` and returns candidates best first, at most `ctx.candidateLimit`. `client` comes from one `withConnection` call. `PostgresRagDatabase` does not open a transaction or set planner settings for this leg. |

### FtsContext

| Field | Type | Description |
|---|---|---|
| `tenantId` | `string` | Tenant to search. Must be applied. |
| `query` | `string` | The lexical query: cleaned, normalized, segmented and stop-word-stripped by `RagPipeline`. The strategy builds its own query form from it. |
| `synonyms` | `SynonymLookup` | `language -> term -> expansions`. Empty map when no synonym provider is configured. |
| `language` | `string` | Query language code, for config or index selection. |
| `candidateLimit` | `number` | Maximum rows to return. |
| `sourceTypes` | `string[]` (optional) | Source-type filter. Must be applied. |
| `sourceIds` | `string[]` (optional) | Source-id filter. Must be applied. |
| `languages` | `string[]` (optional) | Row-language filter. Must be applied. |
| `attributeFilter` | `ValidatedFilter` (optional) | Already-validated attribute filter. Must be applied when `supportsAttributeFilters` is `true`. |

Each returned `RankedCandidate` needs `id` (the `rag_documents.id`, used for deduplication across legs), `content`, `sourceType`, `sourceId`, `metadata` (JSON text) and, ideally, `attributes` (JSON text) and `score` (used by linear fusion). `toRankedCandidate` maps a row with the columns `id, content, source_type, source_id, metadata, attributes, score`.

### Writing a strategy

`buildFilters(ctx, startIdx)` returns the shared filter clause (prefixed with `AND`) and its parameters, numbered from `$startIdx`. Both helpers are described on [Utilities](/reference/utilities).

```ts
import {
  buildFilters,
  type FtsContext,
  type FtsStrategy,
  type RankedCandidate,
  type SqlClient,
  toRankedCandidate,
} from "pg-hybrid-rag";

class PhraseFts implements FtsStrategy {
  readonly supportsAttributeFilters = true;

  async search(client: SqlClient, ctx: FtsContext): Promise<RankedCandidate[]> {
    const f = buildFilters(ctx, 5); // $1 tenant, $2 query, $3 limit, $4 language
    const rows = await client.query<Record<string, unknown>>(
      `SELECT id, content, source_type, source_id, metadata, attributes::text AS attributes,
              ts_rank_cd(content_tsvector, q) AS score
         FROM rag_documents, phraseto_tsquery(rag_fts_config($4), $2) q
        WHERE tenant_id = $1 AND content_tsvector @@ q ${f.clause}
        ORDER BY score DESC
        LIMIT $3`,
      [ctx.tenantId, ctx.query, ctx.candidateLimit, ctx.language, ...f.params],
    );
    return rows.map(toRankedCandidate);
  }
}
```

## TsvectorFts

<!-- no-check -->
```ts
new TsvectorFts()
```

No options. `supportsAttributeFilters` is `true`. Requires only the base migrations.

`search()` behavior:

1. Build a tsquery string with `buildFtsQuery(ctx.query, ctx.synonyms)`: query words joined by `&`, a word or phrase with synonyms becomes an OR group such as `(phones | smartphones | iphone)`, and multi-word terms become `<->` phrases. Characters special to tsquery (`& | ! ( ) : < > * \ ' "`) are removed.
2. If that string contains `|`, `&` or `<->`, match with `to_tsquery(rag_fts_config(language), built)`. Otherwise (a single word with no synonyms, or an empty result) match with `plainto_tsquery(rag_fts_config(language), ctx.query)`.
3. Run:
   - match: `content_tsvector @@ <tsquery>`
   - score: `ts_rank_cd(content_tsvector, <tsquery>)`
   - order: score descending, then `source_type, source_id, chunk_index, id`
   - `LIMIT candidateLimit`

`content_tsvector` is built by a trigger from `content_normalized` with each row's own language config. `rag_fts_config(language)` maps the query language to a Postgres text search config, `simple` for unmapped languages; see [Languages](/reference/languages). The tsquery is built with the query language's config, while each row's tsvector uses the row's config; a term matches only when the resulting lexemes are equal.

Synonym lookups from all languages are merged into one map at query time, with at most 5 expansions per term. See [Utilities](/reference/utilities) for `buildFtsQuery`.

## Bm25Fts

<!-- no-check -->
```ts
new Bm25Fts()
```

No options. `supportsAttributeFilters` is `true`.

Requires the pg_textsearch extension in `shared_preload_libraries` and `ragMigrate({ bm25: true })`, which applies migrations 011 and 015 (BM25 partial indexes on `content_normalized`). See [Use BM25 ranking](/how-to/bm25).

`search()` behavior:

1. Build a flat term list with `buildBm25Query(ctx.query, ctx.synonyms)`: the query words in order, each followed by its synonym expansions (deduplicated against words already present), with tsquery special characters removed. If the list is empty, return `[]` without querying.
2. Pick the BM25 partial index and language predicate for `ctx.language` (see the table below).
3. Run:
   - match and order: `content_normalized <@> to_bm25query($query, '<index name>')` ascending (pg_textsearch returns a negated BM25 score, lower is better)
   - score: the negation of that value, so higher is better
   - where: `tenant_id = $1 AND <language predicate>` plus the shared filters
   - `LIMIT candidateLimit`
4. Drop rows whose score is not greater than 0. pg_textsearch fills the top-K up to the limit with rows that match no query term and score exactly 0; without this step those rows would reach rank fusion as if they were matches.

There is no tie-break ordering on this leg.

### Language-group routing

Each language group has its own partial BM25 index. `ctx.language` is matched exactly (case-sensitive) against these codes:

| Group config | Language codes | Index name | Predicate |
|---|---|---|---|
| `english` | `en`, `en-US`, `en-IN` | `idx_rag_bm25_en` | `language IN ('en', 'en-US', 'en-IN')` |
| `spanish` | `es`, `es-ES`, `es-MX` | `idx_rag_bm25_es` | `language IN (...)` for the group |
| `french` | `fr`, `fr-FR` | `idx_rag_bm25_fr` | same pattern |
| `german` | `de`, `de-DE` | `idx_rag_bm25_de` | same pattern |
| `italian` | `it`, `it-IT` | `idx_rag_bm25_it` | same pattern |
| `portuguese` | `pt`, `pt-PT` | `idx_rag_bm25_pt` | same pattern |
| `romanian` | `ro`, `ro-RO` | `idx_rag_bm25_ro` | same pattern |
| `simple` | every other code | `idx_rag_bm25_simple` | `language NOT IN (<all codes above>)` |

The predicate limits the BM25 leg to rows in the query language's group. Rows in other groups never appear in this leg, even when `languages` is not set; the vector and keyword legs are not limited this way.

Arabic (`ar`) uses the `simple` BM25 group even though `rag_fts_config` maps it to the `arabic` stemmer for `TsvectorFts`.

## Related

- [PostgresRagDatabase](/reference/postgres-rag-database)
- [Use BM25 ranking](/how-to/bm25)
- [Stop words and synonyms](/how-to/stop-words-and-synonyms)
- [Language processing](/explanation/language-processing)
