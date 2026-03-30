# pg-hybrid-rag

Hybrid RAG search pipeline with vector + trigram + full-text search, fused via Reciprocal Rank Fusion (RRF). Postgres-native multilingual stemming, per-tenant stop words, synonym expansion, and optional CJK support via pg_bigm. Zero npm dependencies.

## Installation

```bash
npm install pg-hybrid-rag
# or
pnpm add pg-hybrid-rag
# or
bun add pg-hybrid-rag
```

**Prerequisites:**
- **Node.js 18+** or **Bun 1.0+** (Node 21.2+ required for auto-detected migration paths; pass `sqlDir` explicitly on older Node versions)
- PostgreSQL with `pgvector` and `pg_trgm` extensions
- Optional: `pg_bigm` extension for CJK keyword search
- For non-Bun runtimes, add `@types/node` as a dev dependency for type checking

## Quick Start

```typescript
import {
  RagPipeline,
  RagIndexer,
  Chunker,
  PostgresRagDatabase,
  OpenAiCompatibleEmbedder,
  ragMigrate,
} from "pg-hybrid-rag";

// 1. Apply migrations
await ragMigrate(sqlClient);
// With CJK support: await ragMigrate(sqlClient, { cjk: true });

// 2. Set up adapters
const embedder = new OpenAiCompatibleEmbedder({
  baseUrl: "https://api.example.com",
  apiKey: "sk-...",
  model: "multilingual-e5-small",
});

const db = new PostgresRagDatabase(txProvider);
// With CJK: new PostgresRagDatabase(txProvider, { cjk: true });

// 3. Search
const pipeline = new RagPipeline({
  tenantId: "my-tenant",
  db,
  embedder,
});
const results = await pipeline.search("blue cotton shirt", { language: "en" });

// 4. Index
const indexer = new RagIndexer({ tenantId: "my-tenant", db, embedder });
const chunker = new Chunker(512, 75);
const chunks = chunker.chunk(text, { name: "Product Name" });
await indexer.index("product", productId, chunks, "en");
```

## Language Support

Stemming is handled by Postgres via language-specific FTS configurations. The `rag_fts_config()` SQL function maps language codes to Postgres `regconfig` names. Both short codes (`en`) and BCP-47 locale codes (`en-US`, `fr-FR`) are supported.

| Language | Accepted Codes | Postgres FTS Config | Stemming | Keyword Search |
|----------|---------------|---------------------|----------|---------------|
| English | `en`, `en-US`, `en-IN` | `english` | Yes | pg_trgm |
| Spanish | `es`, `es-ES`, `es-MX` | `spanish` | Yes | pg_trgm |
| French | `fr`, `fr-FR` | `french` | Yes | pg_trgm |
| German | `de`, `de-DE` | `german` | Yes | pg_trgm |
| Italian | `it`, `it-IT` | `italian` | Yes | pg_trgm |
| Portuguese | `pt`, `pt-PT` | `portuguese` | Yes | pg_trgm |
| Romanian | `ro`, `ro-RO` | `romanian` | Yes | pg_trgm |
| Hindi | `hi`, `hi-IN` | `simple` | No | pg_trgm |
| Arabic | `ar`, `ar-SA` | `simple` | No | pg_trgm |
| Malay | `ms` | `simple` | No | pg_trgm |
| Sinhalese | `si`, `si-LK` | `simple` | No | pg_trgm |
| Chinese | `zh`, `zh-CN` | `simple` | No | pg_bigm (requires `cjk: true`) |
| Japanese | `ja`, `ja-JP` | `simple` | No | pg_bigm (requires `cjk: true`) |
| Korean | `ko`, `ko-KR` | `simple` | No | pg_bigm (requires `cjk: true`) |
| Other | any string | `simple` | No | pg_trgm |

**Notes:**
- Languages with native Postgres stemming get morphological normalization in the FTS leg (e.g. "running" → "run").
- Languages using `simple` config get word-level tokenization and lowercase matching only. The vector and keyword legs compensate — vector search handles semantics, pg_trgm handles fuzzy character overlap.
- CJK languages need `pg_bigm` for effective keyword search because they lack whitespace between words. Without `cjk: true`, CJK keyword search falls back to pg_trgm (degraded).
- To add new language codes, update the `rag_fts_config()` function in `sql/008_postgres_stemming.sql`. Postgres supports additional configs including `dutch`, `danish`, `finnish`, `hungarian`, `norwegian`, `russian`, `swedish`, and `turkish`.

## API Reference

### Search

```typescript
const pipeline = new RagPipeline({
  tenantId: string,
  db: RagDatabase,
  embedder: EmbeddingProvider,
  stopWords?: StopWordsProvider,   // optional
  synonyms?: SynonymProvider,      // optional
  reranker?: RerankerProvider,     // optional (cross-encoder)
  logger?: RagLogger,              // optional
  tracer?: RagTracer,              // optional (OTel)
});

const results = await pipeline.search(query, {
  topK?: number,                   // default: 5
  vectorMinScore?: number,         // default: 0.8
  keywordMinScore?: number,        // default: 0.35
  vectorWeight?: number,           // default: 1
  keywordWeight?: number,          // default: 1
  ftsWeight?: number,              // default: 1
  rrfK?: number,                   // default: 60
  sourceTypes?: string[],          // filter by source type
  sourceIds?: string[],            // filter by source ID
  minRelevance?: number,           // 0-1, drop below top * threshold
  language?: string,               // for FTS stemming + keyword search (default: "en")
  normalizer?: { normalize(text, lang): string },
  rerank?: boolean,                // default: false
  rerankerMinScore?: number,       // default: 0.01
});
```

### Index

```typescript
const indexer = new RagIndexer({
  tenantId: string,
  db: RagDatabase,
  embedder: EmbeddingProvider,
  logger?: RagLogger,
});

await indexer.index(sourceType, sourceId, chunks, language);
await indexer.deleteSource(sourceType, sourceId);
```

### Chunk

```typescript
const chunker = new Chunker(maxSize?, overlap?);
const chunks = chunker.chunk(text, metadata?);
```

### Pure Utilities

```typescript
import {
  detectLanguage, removeStopWords, buildFtsQuery, applyRRF,
  stripTrailingPunctuation,
} from "pg-hybrid-rag";

detectLanguage("दौड़ते हुए जूते");           // "hi"
removeStopWords("the best phone", stops); // "best phone"
buildFtsQuery(query, synonymLookup);      // tsquery string
applyRRF(legs, rrfK, topK, weights);      // fused results
stripTrailingPunctuation("phones?");      // "phones"
```

### Migrate

```typescript
import { ragMigrate } from "pg-hybrid-rag";

await ragMigrate(sqlClient);                          // apply pending migrations
await ragMigrate(sqlClient, { rls: true });           // also apply RLS policies
await ragMigrate(sqlClient, { cjk: true });           // also apply CJK (pg_bigm) support
await ragMigrate(sqlClient, { rls: true, cjk: true }); // both
```

SQL files are also available at `pg-hybrid-rag/sql/*` for manual migration systems.

## Adapter Interfaces

Consumers wire their own DB and embedding providers:

```typescript
interface TransactionProvider {
  withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}

interface SqlClient {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
}

interface EmbeddingProvider {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

interface RerankerProvider {
  rerank(query: string, results: RagResult[], topN: number): Promise<RagResult[]>;
}
```

### Prisma Example

```typescript
const txProvider: TransactionProvider = {
  withConnection: (fn) =>
    fn({ query: (sql, params) => prisma.$queryRawUnsafe(sql, ...params) }),
};
```

### postgres.js Example

```typescript
const txProvider: TransactionProvider = {
  withConnection: (fn) => withTenantSql(tenantId, (sql) =>
    fn({ query: (text, params) => sql.unsafe(text, params) })
  ),
};
```

## Default Adapters

- **PostgresRagDatabase** — parameterized SQL for 3-way hybrid search + CRUD; runs all 3 search legs in parallel; optional `{ cjk: true }` for pg_bigm keyword search on CJK languages
- **OpenAiCompatibleEmbedder** — fetch-based, works in Node + Bun
- **CachingStopWordsLoader** — 30s TTL, queries `rag_stop_words`; `loadMerged()` caches flattened Set across languages
- **CachingSynonymLoader** — 30s TTL, queries `rag_synonyms`, two-way direction

### Reranking

The library supports optional cross-encoder reranking post-RRF via a `RerankerProvider`. You provide the implementation — the library handles integration, graceful degradation, and score cutoff.

```typescript
// Example: TEI-compatible reranker
const reranker: RerankerProvider = {
  async rerank(query, results, topN) {
    const res = await fetch(`${RERANKER_URL}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        texts: results.map((r) => r.content),
        truncate: true,
      }),
    });
    const ranked = await res.json() as Array<{ index: number; score: number }>;
    return ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map((item) => ({ ...results[item.index], score: item.score }));
  },
};

const pipeline = new RagPipeline({ tenantId, db, embedder, reranker });
const results = await pipeline.search("blue shirt", { rerank: true });
```

Reranking is opt-in (`rerank: false` by default). If the reranker throws, the pipeline gracefully falls back to RRF results.

## Schema

The package manages 3 tables: `rag_documents`, `rag_stop_words`, `rag_synonyms`. All include `tenant_id` for multi-tenant isolation. RLS policies are optional (migration 007). CJK support via pg_bigm is optional (migration 009).

Stemming is handled by the `rag_fts_config()` SQL function which maps language codes to Postgres `regconfig` names. The tsvector trigger auto-applies the correct stemmer per row based on the `language` column.

## What This Package Does NOT Include

- No job queue — use your own (pg-boss, BullMQ, etc.)
- No text builders — domain-specific text generation stays in consumer apps
- No CRUD routes — admin APIs for stop words/synonyms are consumer concerns
- No config loading — tenant settings, feature flags, etc. are consumer concerns
- No NLP dependencies — stemming is fully delegated to Postgres
