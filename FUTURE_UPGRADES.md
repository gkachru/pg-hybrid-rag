# Future Upgrades

This document covers Postgres extensions that can improve search quality and performance as pg-hybrid-rag scales. Both are optional drop-in upgrades — the library works without them.

---

## pg_textsearch — BM25 Full-Text Search

**Repo:** https://github.com/timescale/pg_textsearch
**License:** PostgreSQL | **Requires:** PG 17+ | **Status:** v1.0.0 (March 2026)

### What it does

Replaces Postgres's built-in tsvector/tsquery FTS with BM25-ranked full-text search. BM25 is the standard information retrieval ranking function — it accounts for term frequency saturation and document length normalization, producing better relevance scores than `ts_rank_cd`.

### What it replaces in pg-hybrid-rag

| Current | With pg_textsearch |
|---------|--------------------|
| `content_tsvector` column + trigger | Not needed — BM25 indexes `content` directly |
| `rag_fts_config()` SQL function | `text_config` baked into the index |
| `to_tsquery('english', ...)` | `content <@> 'search terms'` |
| `ts_rank_cd` scoring | BM25 scoring with Block-Max WAND optimization |
| GIN index on tsvector | `bm25` index on content |

### Language support

Uses standard Postgres text search configurations — same as current: `english`, `spanish`, `french`, `german`, `italian`, `portuguese`, `romanian`, and `simple` for unsupported languages.

```sql
CREATE INDEX ON rag_documents USING bm25(content) WITH (text_config='english');
```

### Key benefits

- **Better ranking** — BM25 vs basic TF-IDF (`ts_rank_cd`)
- **Faster top-k** — Block-Max WAND skips irrelevant document blocks instead of scoring everything
- **Simpler schema** — no tsvector column, no trigger, no `rag_fts_config()` function
- **Parallel index builds** — 4x+ faster CREATE INDEX on large tables

### Why not yet

1. **No boolean queries** — AND/OR/NOT is on the roadmap but not yet shipped. Our synonym expansion produces OR groups like `(phones | smartphones | iphone)`. With pg_textsearch v1.0, multi-term queries work as implicit OR (BM25 naturally scores documents with more matching terms higher), but explicit OR grouping isn't available. Synonym expansion would need to flatten to plain term lists.

2. **One index per language** — A single BM25 index uses one `text_config`. Mixed-language rows in one table would need either:
   - A `simple` config index (no stemming — loses the BM25 stemming advantage)
   - Partitioned table by language (each partition gets its own language-specific index)
   - Separate indexes per language (messy)

   Our current tsvector approach handles mixed languages in one table via the per-row trigger.

3. **Multi-tenant filtering** — The roadmap mentions dedicated multi-tenant support as future work. Current filtering uses WHERE clauses which post-filter after the BM25 scan. For large multi-tenant datasets this could be slower than GIN-indexed tsvector with `WHERE tenant_id = $1`.

4. **`shared_preload_libraries`** — Requires server configuration + restart. Not a pure `CREATE EXTENSION`.

### When to adopt

Once boolean queries ship and multi-tenant support lands, pg_textsearch becomes a clear upgrade for the FTS leg. It could be added as an alternative FTS adapter alongside the current tsvector approach.

### Migration sketch

```sql
-- Requires shared_preload_libraries = 'pg_textsearch' in postgresql.conf
CREATE EXTENSION IF NOT EXISTS pg_textsearch;

-- One index per language partition, or use 'simple' for all
CREATE INDEX idx_rag_bm25_en ON rag_documents USING bm25(content)
  WITH (text_config='english')
  WHERE language IN ('en', 'en-US', 'en-IN');

-- Query changes
-- Before: ts_rank_cd(content_tsvector, to_tsquery(rag_fts_config($4), $2))
-- After:  -(content <@> to_bm25query($2, 'idx_rag_bm25_en'))
-- Note: <@> returns negative BM25 scores (lower = better match for ASC ordering)
```

---

## pgvectorscale — DiskANN Vector Search

**Repo:** https://github.com/timescale/pgvectorscale
**License:** PostgreSQL | **Requires:** PG 17+ | **Status:** Mature (since 2023)

### What it does

Adds the StreamingDiskANN index type to pgvector. Based on Microsoft's DiskANN research, it streams from disk instead of loading the entire index into RAM, with better recall-speed tradeoffs than IVFFlat at scale.

### What it replaces in pg-hybrid-rag

| Current | With pgvectorscale |
|---------|--------------------|
| IVFFlat index (100 lists) | DiskANN graph-based index |
| Loads index into RAM | Streams from disk |
| Recall degrades as data grows | Maintains high recall at scale |
| Post-filter by tenant_id | Label-based pre-filtering in index (optional) |

### Drop-in upgrade (no code changes)

DiskANN uses the same `<=>` cosine distance operator as IVFFlat. The only change is the index:

```sql
-- Current
CREATE INDEX USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- With pgvectorscale
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
DROP INDEX IF EXISTS idx_rag_embedding_ivfflat;
CREATE INDEX idx_rag_embedding_diskann
  ON rag_documents USING diskann (embedding vector_cosine_ops);
```

Zero TypeScript code changes. All SQL queries stay identical.

### Label-based filtered search

The biggest win for multi-tenant RAG is **label-based pre-filtering**. Instead of the vector index scanning all tenants and then throwing away non-matching rows, DiskANN prunes during graph traversal.

#### How labels work

DiskANN labels use `SMALLINT[]` arrays with the `&&` (overlap) operator, which has **OR semantics**: "match documents with any of these labels."

For our AND filtering needs (this tenant AND this source type), use **composite labels** — each unique `(tenant_id, source_type)` pair maps to one SMALLINT:

```
Label 1 = (tenant-abc, product)
Label 2 = (tenant-abc, faq)
Label 3 = (tenant-abc, article)
Label 4 = (tenant-xyz, product)
...
```

#### Schema changes

```sql
-- Label mapping table
CREATE TABLE rag_labels (
  id SMALLINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id UUID NOT NULL,
  source_type VARCHAR(50) NOT NULL,
  UNIQUE (tenant_id, source_type)
);

-- Add labels column
ALTER TABLE rag_documents ADD COLUMN labels SMALLINT[];

-- DiskANN index with label support
CREATE INDEX idx_rag_embedding_diskann
  ON rag_documents USING diskann (embedding vector_cosine_ops, labels);
```

#### Query change

```sql
-- Before (post-filter — index scans ALL tenants):
SELECT ... FROM rag_documents
WHERE tenant_id = $1
  AND 1 - (embedding <=> $2::vector) >= $3
ORDER BY embedding <=> $2::vector
LIMIT $4;

-- After (label pre-filter — index only visits matching nodes):
SELECT ... FROM rag_documents
WHERE labels && $1::smallint[]
  AND 1 - (embedding <=> $2::vector) >= $3
ORDER BY embedding <=> $2::vector
LIMIT $4;
```

At query time, look up the composite labels for the tenant + source types, then pass them as the label array.

#### Capacity

SMALLINT range is -32,768 to 32,767 (~65K labels). With 100 tenants × 10 source types = 1,000 labels. Plenty of headroom.

#### What labels don't cover

- **`source_id` filtering** (specific product/FAQ UUID) — too high cardinality for SMALLINT. Still needs post-filtering, but this is already highly selective.

### When to adopt

- **Without labels**: Immediate drop-in upgrade at any scale. Better recall than IVFFlat, lower memory usage.
- **With labels**: Worth it at scale — 10+ tenants with 1M+ chunks each, where post-filtering causes the vector index to scan across all tenants unnecessarily.

For smaller deployments (single tenant, <1M chunks), IVFFlat is fine.

### Considerations

- **Rust + PGRX** — harder to build from source than a C extension
- **macOS x86 (Intel)** — not supported for building from source (ARM Mac is fine, Docker works)
- **No `shared_preload_libraries` needed** — simple `CREATE EXTENSION`

---

## Adoption strategy

Both extensions can be adopted independently:

| Extension | Complexity | Impact | When |
|-----------|-----------|--------|------|
| pgvectorscale (basic) | Low — index swap only | Better vector recall at scale | Anytime on PG 17+ |
| pgvectorscale (with labels) | Medium — schema + query changes | Faster multi-tenant vector search | At scale (10+ tenants, 1M+ chunks) |
| pg_textsearch | High — FTS leg rewrite | Better FTS ranking (BM25) | After boolean queries + multi-tenant support ship |

None of these require changes to the pg-hybrid-rag TypeScript library if implemented at the SQL/adapter level. The `PostgresRagDatabase` adapter can be extended or swapped to support these without touching the pipeline or indexer.
