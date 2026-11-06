# Schema

This page describes the database objects that exist after all migrations have run: tables and columns, indexes, the trigger, SQL functions, and row-level security policies. Objects created only by an optional migration are marked with the `ragMigrate` option that enables them. For the migration history, see [Migrations](/reference/migrations).

## rag_documents

One row per chunk. All search legs read this table.

::: warning
`tenant_id` and `source_id` are `UUID` columns, so every `tenantId` and `sourceId` you pass to the library must be a valid UUID string such as `6f1c2a7e-0b3d-4c8e-9f21-5a6b7c8d9e0f`. A value like `"my-tenant"` or `"article-42"` fails at runtime with a Postgres type error. The same applies to `tenant_id` in `rag_stop_words`, `rag_synonyms` and `rag_metadata_registry`. Map your own identifiers to UUIDs (for example with a lookup table or UUIDv5) before calling the library.
:::

| Column | Type | Null | Default | Set by | Description |
|--------|------|------|---------|--------|-------------|
| `id` | `UUID` | No | `gen_random_uuid()` | Database | Primary key. Returned as `RankedCandidate.id` and used to deduplicate candidates during fusion. |
| `tenant_id` | `UUID` | No | | Library | Tenant that owns the row (the `tenantId` of `RagPipeline`, `RagIndexer` and the loaders). Must be a valid UUID string. Every query filters on it. |
| `source_type` | `VARCHAR(50)` | No | | Library | Source type passed to `RagIndexer.index`. At most 50 characters. |
| `source_id` | `UUID` | Yes | | Library | Source ID passed to `RagIndexer.index`. Must be a valid UUID string. |
| `chunk_index` | `VARCHAR(50)` | No | `'0'` | Library | `Chunk.index` as text. |
| `content` | `TEXT` | No | | Library | Raw chunk text. Returned to callers and embedded. |
| `content_normalized` | `TEXT` | Yes | | Library | Chunk text after the `Normalizer` and `Segmenter` (identical to `content` when neither is configured). Read by the pg_trgm keyword leg, the BM25 leg and the tsvector trigger. Added by migration 013. |
| `language` | `VARCHAR(10)` | No | `'en'` | Library | Language code of the chunk (`chunk.metadata.language`, else the `language` argument of `index`). Selects the stemming configuration and BM25 index. |
| `embedding` | `vector(N)` | No | | Library | Chunk embedding. `N` is `embeddingDimensions` at install time (default 384). |
| `metadata` | `TEXT` | Yes | `'{}'` | Library | `Chunk.metadata` as JSON text. |
| `content_tsvector` | `tsvector` | Yes | | Trigger | Full-text vector. Added by migration 004. |
| `attributes` | `JSONB` | No | `'[]'` | Library | Typed attributes of the source, as an array of stored entries (see [Storage encoding](/reference/filter-grammar#storage-encoding)). Added by migration 017. |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | Database | Insert time. |

Re-indexing a source deletes its rows and inserts new ones, so `id` and `created_at` change on every re-index.

### Indexes

| Index | Definition | Used by | Option |
|-------|------------|---------|--------|
| `rag_documents_pkey` | Primary key on `id` | Row identity | Always |
| `idx_rag_tenant` | B-tree `(tenant_id)` | Tenant filtering, RLS checks | Always |
| `idx_rag_source` | B-tree `(tenant_id, source_type, source_id)` | `deleteBySource`, `replaceSource` | Always |
| `idx_rag_embedding_ivfflat` | IVFFlat `(embedding vector_cosine_ops) WITH (lists = 100)` | Vector leg | Always, unless `vectorchord` |
| `idx_rag_embedding_vchordrq` | `vchordrq (embedding vector_cosine_ops)` | Vector leg | `vectorchord` (replaces IVFFlat) |
| `idx_rag_content_normalized_trgm` | GIN `(content_normalized gin_trgm_ops)` | Keyword leg (pg_trgm) | Always |
| `idx_rag_content_bigm` | GIN `(content gin_bigm_ops)` | Keyword leg for CJK (pg_bigm) | `cjk` |
| `idx_rag_content_fts` | GIN `(content_tsvector)` | Full-text leg (`TsvectorFts`) | Always |
| `idx_rag_bm25_en`, `_es`, `_fr`, `_de`, `_it`, `_pt`, `_ro`, `_simple` | `bm25 (content_normalized)`, partial by language | Full-text leg (`Bm25Fts`) | `bm25` |
| `idx_rag_attributes` | GIN `(attributes jsonb_path_ops)` | Attribute filters (`@>` containment) | Always |

The primary key index name is the Postgres default for an inline `PRIMARY KEY`.

BM25 partial indexes (one `text_config` each):

| Index | `text_config` | `WHERE` |
|-------|---------------|---------|
| `idx_rag_bm25_en` | `english` | `language IN ('en','en-US','en-IN')` |
| `idx_rag_bm25_es` | `spanish` | `language IN ('es','es-ES','es-MX')` |
| `idx_rag_bm25_fr` | `french` | `language IN ('fr','fr-FR')` |
| `idx_rag_bm25_de` | `german` | `language IN ('de','de-DE')` |
| `idx_rag_bm25_it` | `italian` | `language IN ('it','it-IT')` |
| `idx_rag_bm25_pt` | `portuguese` | `language IN ('pt','pt-PT')` |
| `idx_rag_bm25_ro` | `romanian` | `language IN ('ro','ro-RO')` |
| `idx_rag_bm25_simple` | `simple` | `language NOT IN (` all 16 codes above `)` |

### Trigger

| Trigger | Timing | Function |
|---------|--------|----------|
| `trg_rag_documents_tsvector` | `BEFORE INSERT OR UPDATE`, `FOR EACH ROW` | `rag_documents_tsvector_trigger()` |

The function sets:

```sql
NEW.content_tsvector := to_tsvector(
  rag_fts_config(NEW.language),
  COALESCE(NEW.content_normalized, NEW.content)
);
```

Stemming is therefore per row, by the row's `language`. Changing `rag_fts_config` does not update existing rows; they keep their old vector until updated or re-indexed.

## rag_stop_words

Per-tenant, per-language stop words, read by `CachingStopWordsLoader`.

| Column | Type | Null | Default |
|--------|------|------|---------|
| `id` | `UUID` | No | `gen_random_uuid()` (primary key) |
| `tenant_id` | `UUID` | No | |
| `language` | `VARCHAR(10)` | No | |
| `word` | `VARCHAR(100)` | No | |

Indexes: primary key on `id`; `idx_rag_stop_words_tenant (tenant_id)`; unique `idx_rag_stop_words_tenant_lang_word (tenant_id, language, word)` (migration 020). The match is exact and case-sensitive, so `The` and `the` are separate rows. The unique index lets seed scripts use `INSERT ... ON CONFLICT DO NOTHING`.

## rag_synonyms

Per-tenant synonyms, read by `CachingSynonymLoader`.

| Column | Type | Null | Default | Description |
|--------|------|------|---------|-------------|
| `id` | `UUID` | No | `gen_random_uuid()` | Primary key. |
| `tenant_id` | `UUID` | No | | |
| `language` | `VARCHAR(10)` | No | | |
| `term` | `VARCHAR(255)` | No | | Term to expand. |
| `synonyms` | `JSONB` | No | | JSON array of strings. |
| `direction` | `VARCHAR(10)` | No | `'two_way'` | `two_way`: the term expands to each synonym and each synonym expands to the term. `one_way`: only the term expands. |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | Not updated automatically. |

Indexes: primary key on `id`; `idx_rag_synonyms_tenant (tenant_id)`; unique `idx_rag_synonyms_tenant_term_lang (tenant_id, term, language)`.

```sql
INSERT INTO rag_synonyms (tenant_id, language, term, synonyms, direction)
VALUES ('6f1c2a7e-0b3d-4c8e-9f21-5a6b7c8d9e0f', 'en', 'laptop', '["notebook"]', 'two_way');
```

## rag_metadata_registry

Registered metadata keys per tenant, maintained by `CachingMetadataCatalog.register` and `unregister`. Created by migration 018.

| Column | Type | Null | Default | Description |
|--------|------|------|---------|-------------|
| `tenant_id` | `UUID` | No | | |
| `ns` | `TEXT` | No | | Namespace. |
| `key` | `TEXT` | No | | Key. |
| `description` | `TEXT` | No | | Description shown to the filter model. |
| `type` | `TEXT` | Yes | | Declared `AttributeType`. |
| `format` | `TEXT` | Yes | | Declared `AttributeFormat`. |
| `multi` | `BOOLEAN` | Yes | | Declared multi flag. |
| `allowed_values` | `JSONB` | Yes | | JSON array of allowed string values. |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | Set on insert and on each re-registration. |

Primary key: `(tenant_id, ns, key)`.

## _rag_migrations

Tracking table created by `ragMigrate`.

| Column | Type | Null | Default | Description |
|--------|------|------|---------|-------------|
| `name` | `TEXT` | No | | Primary key. Migration file name, for example `017_attributes.sql`. |
| `applied_at` | `TIMESTAMPTZ` | No | `NOW()` | When the file was applied. |

## SQL functions

### rag_fts_config

```sql
rag_fts_config(lang TEXT) RETURNS regconfig  -- PL/pgSQL, IMMUTABLE
```

Maps a language code to a Postgres text search configuration. Matching is exact and case-sensitive; there is no base-code fallback.

| `lang` | Returns |
|--------|---------|
| `en`, `en-US`, `en-IN` | `english` |
| `es`, `es-ES`, `es-MX` | `spanish` |
| `fr`, `fr-FR` | `french` |
| `de`, `de-DE` | `german` |
| `it`, `it-IT` | `italian` |
| `pt`, `pt-PT` | `portuguese` |
| `ro`, `ro-RO` | `romanian` |
| `ar`, `ar-SA`, `ar-EG` | `arabic` |
| Anything else | `simple` |

Used by the tsvector trigger for each row and by `TsvectorFts` for the query (`to_tsquery` or `plainto_tsquery` with `rag_fts_config($language)`). Defined by migration 008 and replaced by migration 014.

### rag_documents_tsvector_trigger

```sql
rag_documents_tsvector_trigger() RETURNS trigger  -- PL/pgSQL
```

The trigger function described under [Trigger](#trigger).

## Row-level security

Created only with `rls: true` (migrations 007, 019, 021 and 022).

| Table | Policy |
|-------|--------|
| `rag_documents` | `rag_documents_tenant_isolation` |
| `rag_stop_words` | `rag_stop_words_tenant_isolation` |
| `rag_synonyms` | `rag_synonyms_tenant_isolation` |
| `rag_metadata_registry` | `rag_metadata_registry_tenant_isolation` |

Each table has `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY` (migration 021), and one policy for all commands:

```sql
USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
```

- With no `WITH CHECK` clause, the same expression also checks inserted and updated rows, so a row can only be written for the current tenant.
- `current_setting(..., true)` returns `NULL` when `app.current_tenant_id` was never set in the session, and an empty string after a transaction-local `set_config(..., true)` has ended. `NULLIF(..., '')` (migration 022) turns the empty string into `NULL`, so in both cases the policy matches no rows instead of raising an error. Before 022, the empty string reached the `::uuid` cast and failed with `invalid input syntax for type uuid`.
- Because of `FORCE`, the policies also apply to the table owner, so a role that owns the tables must set `app.current_tenant_id` like any other role; without it, queries return no rows. Superusers and roles with `BYPASSRLS` are still exempt. Connect as a role that is subject to the policies.

See [Multi-tenancy and row-level security](/how-to/multi-tenancy-rls).

## Related

- [Migrations](/reference/migrations)
- [Languages](/reference/languages)
- [Indexes and performance](/explanation/indexes-and-performance)
