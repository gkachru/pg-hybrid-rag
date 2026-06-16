# Future Upgrades

This document covers Postgres extensions that can improve search quality and performance as pg-hybrid-rag scales. They are optional — the library works without them.

- **Vector leg** — **VectorChord** (preferred for the OCI Ampere A1 / ARM64 stack) or **pgvectorscale**: both swap the IVFFlat index for a better-scaling index with zero TypeScript changes.
- **FTS leg** — **pg_textsearch**: replaces tsvector/tsquery with BM25 ranking. Needs a minor `buildFtsQuery` rewrite, but no missing-feature gates (see the re-assessment below).

> **Shipped in 0.3.0:** **VectorChord** (`vchordrq`) for the vector leg and
> **pg_textsearch** (BM25) for the FTS leg, both opt-in. VectorChord is a
> migration-only swap (`ragMigrate(client, { vectorchord: true })`). BM25 is the
> `Bm25Fts` strategy plus `ragMigrate(client, { bm25: true })`. Both require a
> one-time `shared_preload_libraries` change + rolling restart. pgvectorscale
> remains the documented fallback for the vector leg.

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

### Adoption considerations (re-assessed)

Three of the original "wait" reasons were re-assessed against the pg_textsearch README. Only one is a real constraint.

1. **Boolean queries — not a blocker (originally mislabeled).** What pg_textsearch lacks is *phrase* queries (`"exact phrase"`) and explicit `AND`/`NOT` operators. What pg-hybrid-rag's `buildFtsQuery` actually needs from the FTS leg is **OR semantics for synonym expansion** (`phones | smartphones | iphone`), and BM25 is an OR-ranked model by definition: a space-separated query `phones smartphones iphone` scores any document containing *any* of those terms, weighted by IDF/TF. That is functionally equivalent to tsquery `OR` — and ranks *better*, because it weights by term frequency. No `|` syntax is required; you pass the synonym terms space-separated to `<@>`.

   *Code impact:* `buildFtsQuery` currently emits `best & (phones | smartphones | iphone) & market`. For pg_textsearch it would be rewritten to emit a flat, space-separated term list (drop the `&`, `|`, parentheses, and `<->` phrase operators). Semantic behavior is preserved and improved.

2. **One index per language — still a design choice (not resolved).** A single BM25 index uses one `text_config`. Mixed-language rows in one table still need either:
   - a `simple` config index (no stemming — loses the BM25 stemming advantage),
   - a table partitioned by language (each partition gets its own language-specific index), or
   - separate per-language indexes (messy).

   The current tsvector approach handles mixed languages in one table via the per-row trigger. This remains the main schema-design question for adopting pg_textsearch.

3. **Multi-tenant filtering — supported, not a blocker (originally mislabeled).** pg_textsearch's README documents pre-filtering with a B-tree index on a filter column *before* BM25 scoring: `WHERE tenant_id = $1 ORDER BY content <@> 'query' LIMIT n` uses the B-tree on `tenant_id` to shrink the candidate set before scoring — the exact pattern `PostgresRagDatabase` already uses (`WHERE tenant_id = $1` on every leg).

4. **`shared_preload_libraries` — the one real constraint.** Requires server configuration + a Postgres restart (not a pure `CREATE EXTENSION`). On the OCI Ampere A1 setup (N+1 instances behind a load balancer) this is a **rolling restart** — an ops step, not an architectural blocker.

### When to adopt

The original blockers (boolean queries, multi-tenant filtering) don't apply — pg_textsearch is a viable upgrade for the FTS leg today. The remaining work is operational and minor:

- the `shared_preload_libraries` rollout (rolling restart),
- the `buildFtsQuery` flattening (drop the tsquery operators), and
- a decision on the per-language index strategy (partition vs `simple`).

It is best added as an alternative FTS adapter alongside the current tsvector approach, selectable per deployment.

### Migration sketch

```sql
-- Requires shared_preload_libraries = 'pg_textsearch' in postgresql.conf (+ restart)
CREATE EXTENSION IF NOT EXISTS pg_textsearch;

-- One index per language partition, or use 'simple' for all
CREATE INDEX idx_rag_bm25_en ON rag_documents USING bm25(content)
  WITH (text_config='english')
  WHERE language IN ('en', 'en-US', 'en-IN');

-- B-tree on tenant_id lets BM25 pre-filter by tenant before scoring (README pattern)
CREATE INDEX IF NOT EXISTS idx_rag_tenant ON rag_documents (tenant_id);
```

Query changes (in `PostgresRagDatabase`):

```sql
-- Before (tsvector + tsquery OR groups):
SELECT ..., ts_rank_cd(content_tsvector, to_tsquery(rag_fts_config($4), $2)) AS score
FROM rag_documents
WHERE tenant_id = $1
  AND content_tsvector @@ to_tsquery(rag_fts_config($4), $2)   -- $2 = "best & (phones | smartphones | iphone)"
ORDER BY score DESC LIMIT $3;

-- After (BM25, flat term list, B-tree tenant pre-filter):
SELECT ..., -(content <@> $2) AS score                         -- $2 = "best phones smartphones iphone"
FROM rag_documents
WHERE tenant_id = $1
ORDER BY content <@> $2 LIMIT $3;
-- Note: <@> returns negative BM25 distances (lower = better) so order ASC; negate for a positive
--       RRF score. buildFtsQuery emits the flat term list — no &, |, or parentheses.
```

---

## VectorChord — RaBitQ Vector Search

**Repo:** https://github.com/tensorchord/VectorChord
**License:** AGPLv3 / Elastic License v2 (dual) | **Requires:** PG 17+, pgvector | **Status:** Stable (v1.1.x) — successor to pgvecto.rs

> **Preferred vector-leg upgrade for the OCI Ampere A1 (ARM64) stack.** ARM64 is first-class, it's production-proven, and `vchordrq` is strictly better than IVFFlat at scale. pgvectorscale (below) remains a valid alternative — see the trade-off table.

### What it does

Adds the `vchordrq` index — a graph index with RaBitQ quantization — for scalable, disk-friendly vector search. Reported up to ~5x faster queries, ~16x higher insert throughput, and ~16x faster index builds than pgvector's HNSW, while keeping memory low. Built on top of pgvector's `vector` type.

### What it replaces in pg-hybrid-rag

| Current | With VectorChord |
|---------|------------------|
| IVFFlat index (100 lists) | `vchordrq` (RaBitQ-quantized graph) index |
| Recall degrades as data grows | Maintains high recall at scale |
| Loads index into RAM | Quantized, disk-friendly footprint |

### Drop-in upgrade (no code changes)

`vchordrq` uses the same `<=>` cosine operator and `vector_cosine_ops` opclass as IVFFlat, so every SQL query and all TypeScript stay identical — only the index changes:

```sql
-- One-time server config, then restart Postgres (rolling restart on the N+1 fleet):
ALTER SYSTEM SET shared_preload_libraries = 'vchord';

CREATE EXTENSION IF NOT EXISTS vchord CASCADE;     -- pulls in pgvector via CASCADE
DROP INDEX IF EXISTS idx_rag_embedding_ivfflat;
CREATE INDEX idx_rag_embedding_vchordrq
  ON rag_documents USING vchordrq (embedding vector_cosine_ops);
```

Queries are unchanged (`... ORDER BY embedding <=> $2::vector LIMIT $4`). Zero TypeScript changes.

### VectorChord vs pgvectorscale

| | VectorChord (`vchordrq`) | pgvectorscale (`diskann`) |
|---|---|---|
| ARM64 / OCI Ampere (Neoverse N1) | First-class | Supported (Rust/PGRX build) |
| Quantization / recall | RaBitQ — theoretical error bound | SBQ (Statistical Binary Quantization) |
| Development activity | More active | Mature, slower cadence |
| Install | `shared_preload_libraries` + restart | Plain `CREATE EXTENSION` (no restart) |
| License | AGPLv3 / ELv2 (manageable here) | PostgreSQL |
| Multi-tenant pre-filter | `WHERE` / B-tree pre-filter | Label-based in-index pre-filter (`SMALLINT[]`) |
| Code changes | None (index swap) | None for basic; schema + query for labels |

For this stack VectorChord is the chosen path (see the next-version note at the top) — it wins on development activity, ARM64 / Neoverse N1 support, and RaBitQ's error-bounded recall, and its license is manageable here. pgvectorscale stays a fallback for deployments where AGPLv3/ELv2 is a hard blocker or the `shared_preload_libraries` restart must be avoided.

### Considerations

- **`shared_preload_libraries = 'vchord'` + restart** — the same operational step as pg_textsearch (a rolling restart on the N+1 OCI fleet). This is the one caveat to the "pure index swap" framing.
- **Licensing** — AGPLv3 / Elastic License v2 (vs pgvectorscale's PostgreSQL license). Assessed as manageable for this deployment (internal service, not redistributed); revisit if the library or a derivative is ever distributed externally.
- **Depends on pgvector** — already installed (migration 001); `CASCADE` handles it.

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

The alternative to **VectorChord** for the vector leg. Prefer pgvectorscale when you want to avoid the `shared_preload_libraries` restart, or when its **label-based in-index pre-filtering** (above) is the priority for multi-tenant search.

- **Without labels**: Immediate drop-in upgrade at any scale. Better recall than IVFFlat, lower memory usage.
- **With labels**: Worth it at scale — 10+ tenants with 1M+ chunks each, where post-filtering causes the vector index to scan across all tenants unnecessarily.

For smaller deployments (single tenant, <1M chunks), IVFFlat is fine.

### Considerations

- **Rust + PGRX** — harder to build from source than a C extension
- **macOS x86 (Intel)** — not supported for building from source (ARM Mac is fine, Docker works)
- **No `shared_preload_libraries` needed** — simple `CREATE EXTENSION`

---

## Adoption strategy

Each extension can be adopted independently. The vector leg has two alternatives (pick one); the FTS leg has one.

| Extension | Leg | Complexity | Impact | When |
|-----------|-----|-----------|--------|------|
| **VectorChord** (`vchordrq`) | Vector | Low — index swap + `shared_preload_libraries` restart | Better recall & throughput at scale; ARM64-native; RaBitQ error-bounded recall | **Shipped in 0.3.0** (preferred on OCI ARM, PG 17+) |
| pgvectorscale (basic) | Vector | Low — index swap, no restart | Better vector recall at scale | Fallback — if AGPL/ELv2 or the restart is a blocker |
| pgvectorscale (with labels) | Vector | Medium — schema + query changes | Faster multi-tenant vector search | At scale (10+ tenants, 1M+ chunks) |
| pg_textsearch | FTS | Medium — flatten `buildFtsQuery` + ops | Better FTS ranking (BM25) | **Shipped in 0.3.0** — lands with VectorChord's restart |

Vector-leg upgrades (VectorChord, pgvectorscale-basic) need **zero TypeScript changes** — pure SQL/adapter index swaps. pg_textsearch needs a minor `buildFtsQuery` change (flatten the tsquery operators to a space-separated term list) plus adapter SQL changes; the pipeline and indexer are untouched. The `PostgresRagDatabase` adapter can be extended or swapped to support any of these.
