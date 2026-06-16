# VectorChord + pg_textsearch Integration — Design

**Date:** 2026-06-16
**Branch:** `feat/vectorchord-pg-textsearch`
**Target version:** 0.3.0
**Status:** Approved design — pending implementation plan

## Goal

Adopt two optional Postgres extensions, both gated behind a single rolling
restart on the OCI Ampere A1 fleet:

- **VectorChord (`vchordrq`)** — replaces the IVFFlat vector index with a
  RaBitQ-quantized graph index. Better recall and throughput at scale,
  ARM64-native. **Migration only — zero adapter/TypeScript changes** (identical
  `<=>` operator and `vector_cosine_ops` opclass).
- **pg_textsearch (BM25)** — replaces the tsvector/tsquery FTS leg with BM25
  ranking. Adds a pluggable FTS strategy + a new migration. The existing
  tsvector path remains the default; BM25 is opt-in and coexists.

Both are optional and selectable per deployment. Neither is forced on existing
users.

## Non-goals (YAGNI)

- pgvectorscale (`diskann`) — remains the documented fallback in
  `FUTURE_UPGRADES.md`, not implemented here.
- Label-based / composite-label in-index pre-filtering.
- Dropping the tsvector column/trigger — BM25 coexists; deployments can switch
  back.
- Auto-detecting which extensions are installed at runtime — selection is
  explicit (constructor + migration flags), consistent with the library's
  "no magic, explicit config" convention.

## Key decisions

1. **Pluggable FTS strategy object** injected into `PostgresRagDatabase` (not
   option flags, not a separate adapter class). The FTS leg is the only thing
   that varies; the strategy owns the FTS query-string form *and* the FTS-leg
   SQL. Aligns with the codebase's interface-first / dependency-injection
   philosophy.
2. **Per-language partial BM25 indexes** — one partial index per language group
   (`WHERE language IN (...)` with its `text_config`), plus a `simple` partial
   index for unsupported languages. Keeps stemming, mirrors the existing
   `rag_fts_config(language)` model, additive (no table restructure).
3. **Unit tests (mocked) + live playground variant** — mock-based unit tests for
   query-string building and SQL shape, plus an opt-in playground path against an
   extension-enabled Postgres image.

## Architecture

### The `FtsStrategy` abstraction

The vector and keyword legs of `PostgresRagDatabase.hybridSearch` stay inline and
unchanged. The FTS leg becomes a pluggable strategy.

```ts
// interfaces.ts
export interface FtsStrategy {
  /** Run the FTS leg: build the query string, compose SQL, execute, map rows. */
  search(client: SqlClient, ctx: FtsContext): Promise<RankedCandidate[]>;
}

export interface FtsContext {
  tenantId: string;
  query: string;              // normalized, stop-words removed
  synonyms: SynonymLookup;
  language: string;
  candidateLimit: number;
  filters: FilterClauses;     // shared source/source-id/language WHERE-clause + param helper
  toCandidate(row: Record<string, unknown>): RankedCandidate;
}
```

Two implementations:

- **`TsvectorFts`** (default) — current behavior. Builds the tsquery string via
  the existing `buildFtsQuery`, runs
  `ts_rank_cd(content_tsvector, to_tsquery(rag_fts_config($lang), $q))` with the
  tsquery/plainto branch preserved.
- **`Bm25Fts`** — builds a flat term list via `buildBm25Query`, runs
  `-(content <@> $q) AS score ... ORDER BY content <@> $q` (ASC; `<@>` returns
  negative BM25 distance, lower = better, negate for a positive RRF score), with
  a language-group predicate so the planner selects the matching partial index.

`PostgresRagDatabase` gains one option, defaulting to today's behavior:

```ts
export interface PostgresRagDatabaseOptions {
  cjk?: boolean;             // unchanged
  fts?: FtsStrategy;         // default: new TsvectorFts()
}

new PostgresRagDatabase(tx, { fts: new Bm25Fts() });
```

### Shared filter-clause helper

The source-type / source-id / language WHERE clauses and dynamic `$N`
param-index bookkeeping are currently built inline in `hybridSearch` and shared
across all three legs. Extract them into a small reusable `FilterClauses` helper
(e.g. `src/adapters/filterClauses.ts`) so the inline vector/keyword legs and both
FTS strategies compose SQL the same way without re-implementing it. **No behavior
change** — pure deduplication to enable the strategy to build its own SQL.

### Data-flow change (the one pipeline edit)

Today the **pipeline** pre-builds `ftsQueryStr` via `buildFtsQuery` and passes it
in `HybridSearchParams`. Since the strategy now owns the FTS query-string form,
the pipeline stops building it and passes the raw `synonymLookup` instead; the
strategy builds whichever form it needs.

`HybridSearchParams`:
- **remove** `ftsQueryStr: string`
- **add** `synonymLookup: SynonymLookup`
- `query` stays (keyword leg + base for FTS query building)

`RagPipeline.search` drops its `import { buildFtsQuery }` and the
`const ftsQueryStr = buildFtsQuery(...)` line; it passes `synonymLookup` (already
loaded in the same `Promise.all`) straight through to `hybridSearch`. That
`buildFtsQuery` call moves into `TsvectorFts`.

**Breaking change:** `HybridSearchParams` and the `RagDatabase` contract change
shape. Anyone implementing `RagDatabase` directly is affected. Deliberate API
evolution → **version bump to 0.3.0**. (Alternative considered: keep
`ftsQueryStr` for back-compat alongside `synonymLookup`. Rejected — it would force
the pipeline to build a tsquery string that `Bm25Fts` never uses, and leaves dead
data on the params object.)

## Query-string building (`synonymExpander.ts`)

- `TsvectorFts` reuses `buildFtsQuery` unchanged (tsquery `&` / `|` / `<->`).
- New exported **`buildBm25Query(query, lookup): string`** — a flat,
  space-separated synonym-expanded term list. Reuses the existing
  longest-match-first sliding-window synonym logic (the same logic behind
  `expandQueryWithSynonyms`), then applies a `sanitizeBm25Term` pass to strip any
  characters special to the `<@>` parser (quotes / operators), preventing query
  injection.

Example — query `best phones market`, synonyms `phones → [smartphones, iphone]`:

```
buildFtsQuery  → "best & (phones | smartphones | iphone) & market"   (tsquery)
buildBm25Query → "best phones smartphones iphone market"             (flat, OR-ranked)
```

BM25 is OR-ranked by definition: a space-separated query scores any document
containing any term, weighted by IDF/TF — functionally equivalent to the tsquery
OR group, ranked better.

## Language-group scoping (partial-index requirement)

A partial BM25 index `WHERE language IN ('en','en-US','en-IN')` is only used by
the planner when the query carries a matching literal predicate. So `Bm25Fts`
emits `AND language IN (<group literals>)` for `params.language`'s group, mapping
unsupported languages to the `simple` group
(`language NOT IN (<all supported>)`).

**Single source of truth:** define `BM25_LANGUAGE_GROUPS` once in TypeScript;
the migration SQL literals must match exactly (partial-index predicate matching
requires literal arrays, not a function call). A unit test asserts the TS
constant and the migration literals stay in sync. The groups mirror
`rag_fts_config`'s mapping (`en/es/fr/de/it/pt/ro` + `simple` catch-all) but as
literal arrays.

**Documented semantic nuance:** the BM25 FTS leg is single-config per query
(scoped to `params.language`'s group), whereas the current tsvector leg stems the
query in one config but matches across all rows regardless of language. In
practice each search already passes one `language`, so behavior is consistent;
cross-language FTS within a single query is the edge case that changes.

## Migrations

Follow the existing filename-substring + `MigrateOptions` flag gating pattern
(as used for `rls` and `cjk`). Both new migrations are opt-in and additive.

`MigrateOptions` gains:
```ts
vectorchord?: boolean;   // apply 010 (vchordrq index swap)
bm25?: boolean;          // apply 011 (pg_textsearch BM25 indexes)
```

`migrate.ts` filter chain gains:
```ts
.filter((f) => options.vectorchord || !f.includes("vectorchord"))
.filter((f) => options.bm25 || !f.includes("textsearch"))
```

### `sql/010_vectorchord.sql` (gated by `vectorchord`)

```sql
-- Prerequisite (ops, NOT in this migration):
--   shared_preload_libraries = 'vchord' in postgresql.conf + restart
CREATE EXTENSION IF NOT EXISTS vchord CASCADE;     -- pulls in pgvector via CASCADE
DROP INDEX IF EXISTS idx_rag_embedding_ivfflat;
CREATE INDEX IF NOT EXISTS idx_rag_embedding_vchordrq
  ON rag_documents USING vchordrq (embedding vector_cosine_ops);
```

This migration *does* drop the IVFFlat index — a genuine swap (a deployment
wanting both vector index types is not a real use case). No adapter code changes:
queries still use `embedding <=> $2::vector`.

### `sql/011_pg_textsearch.sql` (gated by `bm25`)

```sql
-- Prerequisite (ops): shared_preload_libraries includes 'pg_textsearch'
--   (alongside 'vchord' if both adopted) + restart
CREATE EXTENSION IF NOT EXISTS pg_textsearch;

-- One partial index per language group; literals mirror BM25_LANGUAGE_GROUPS.
CREATE INDEX IF NOT EXISTS idx_rag_bm25_en ON rag_documents USING bm25(content)
  WITH (text_config='english')    WHERE language IN ('en','en-US','en-IN');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_es ON rag_documents USING bm25(content)
  WITH (text_config='spanish')    WHERE language IN ('es','es-ES','es-MX');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_fr ON rag_documents USING bm25(content)
  WITH (text_config='french')     WHERE language IN ('fr','fr-FR');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_de ON rag_documents USING bm25(content)
  WITH (text_config='german')     WHERE language IN ('de','de-DE');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_it ON rag_documents USING bm25(content)
  WITH (text_config='italian')    WHERE language IN ('it','it-IT');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_pt ON rag_documents USING bm25(content)
  WITH (text_config='portuguese') WHERE language IN ('pt','pt-PT');
CREATE INDEX IF NOT EXISTS idx_rag_bm25_ro ON rag_documents USING bm25(content)
  WITH (text_config='romanian')   WHERE language IN ('ro','ro-RO');
-- Catch-all for unsupported languages (no stemming).
CREATE INDEX IF NOT EXISTS idx_rag_bm25_simple ON rag_documents USING bm25(content)
  WITH (text_config='simple')
  WHERE language NOT IN ('en','en-US','en-IN','es','es-ES','es-MX',
                         'fr','fr-FR','de','de-DE','it','it-IT',
                         'pt','pt-PT','ro','ro-RO');

-- B-tree on tenant_id (idx_rag_tenant, migration 002) already provides the
-- pre-filter pg_textsearch uses before BM25 scoring.
```

Coexists with the tsvector column/trigger — nothing on the FTS side is dropped,
so a deployment can run tsvector or BM25 and switch back by changing the
`fts` strategy.

`CREATE EXTENSION` fails loudly if `shared_preload_libraries` isn't set — that is
the single documented ops prerequisite (one rolling restart brings up both legs).

## API surface changes

- `interfaces.ts`: add `FtsStrategy`, `FtsContext`.
- `PostgresRagDatabaseOptions`: add `fts?: FtsStrategy` (default `new TsvectorFts()`).
- New files: `src/adapters/fts/TsvectorFts.ts`, `src/adapters/fts/Bm25Fts.ts`,
  `src/adapters/filterClauses.ts`.
- `synonymExpander.ts`: add exported `buildBm25Query`.
- `types.ts`: `HybridSearchParams` — remove `ftsQueryStr`, add `synonymLookup`.
- `migrate.ts` / `MigrateOptions`: add `vectorchord?`, `bm25?` + filter rules.
- `src/index.ts` barrel: export `FtsStrategy`, `FtsContext`, `TsvectorFts`,
  `Bm25Fts`, `buildBm25Query`.

Coordinated switches a deployment sets together:
```ts
await ragMigrate(client, { vectorchord: true, bm25: true });
const db = new PostgresRagDatabase(tx, { fts: new Bm25Fts() });
```
VectorChord alone needs only the migration flag — no adapter change.

## Testing

### Unit tests (mocked `SqlClient` — no real DB, per convention)
- `buildBm25Query`: synonym expansion, dedup, multi-word keys, sanitization
  (injection chars stripped).
- `Bm25Fts.search`: emits expected SQL — score `-(content <@> $q)`,
  `ORDER BY content <@> $q` (ASC), language-group predicate for the right group,
  correct `$N` indexing with/without source/source-id/language filters.
- `TsvectorFts.search`: still emits today's SQL (regression guard).
- `BM25_LANGUAGE_GROUPS` ⇔ migration `011` literals stay in sync (parse the SQL,
  compare).
- `FilterClauses` helper: same clauses/params as the previous inline logic.

### Live playground variant
- `examples/playground.ts` gains `--vectorchord` and `--bm25` flags; when set, it
  runs `ragMigrate` with the matching options and constructs the adapter with
  `Bm25Fts`.
- The example `compose` switches to a base image carrying `vchord` +
  `pg_textsearch` with `shared_preload_libraries` set (run via `podman compose`).
- Assertions: searches return results and BM25 scores are sane (positive after
  negation, ordered).

## Docs

- `FUTURE_UPGRADES.md` — mark VectorChord + pg_textsearch as **shipped in 0.3.0**;
  keep pgvectorscale as the documented fallback.
- `CLAUDE.md` — document the FTS strategy pattern, the two new migrations + flags,
  the BM25 language-group nuance, and the `HybridSearchParams` change.
- `README.md` — BM25 / VectorChord opt-in setup and the `shared_preload_libraries`
  prerequisite.

## Rollout sequencing (ops)

1. Set `shared_preload_libraries = 'vchord,pg_textsearch'`; rolling restart of
   the N+1 fleet.
2. `ragMigrate(client, { vectorchord: true, bm25: true })`.
3. Deploy app with `new PostgresRagDatabase(tx, { fts: new Bm25Fts() })`.

VectorChord and pg_textsearch can also be adopted independently (each flag is
separate); they are bundled here only because they share the one restart.
