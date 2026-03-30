# pg-hybrid-rag

Hybrid RAG search pipeline with vector + trigram + full-text search, fused via Reciprocal Rank Fusion (RRF). Postgres-native multilingual stemming, per-tenant stop words, synonym expansion, and optional CJK support via pg_bigm. Zero npm dependencies.

## Why pg-hybrid-rag?

Most RAG implementations rely on vector search alone. That works for semantic queries ("comfortable running shoes") but fails on exact matches ("Nike Air Max 270"), product codes, and keyword-heavy searches. pg-hybrid-rag runs three search strategies in parallel — vector similarity, trigram matching, and full-text search — then fuses them with RRF so you get the best of all three without tuning each one independently.

Everything runs inside Postgres. No Elasticsearch, no Redis, no external search engine. If you already have Postgres with pgvector, you can add hybrid search without new infrastructure. Stemming, stop words, synonyms, and language detection are all handled natively — 14 languages supported out of the box, with CJK support via pg_bigm. The library has zero npm dependencies and injects all I/O through interfaces, so it works with any database driver, any embedding provider, and any framework.

## Installation

```bash
npm install pg-hybrid-rag
# or
pnpm add pg-hybrid-rag
# or
bun add pg-hybrid-rag
```

In a monorepo, if this package lives alongside your consumer (e.g. `packages/rag` and `packages/api`), you can reference it locally instead. With pnpm/bun workspaces configured, use `workspace:*`. Without workspaces, use a relative path:

```json
{
  "dependencies": {
    "pg-hybrid-rag": "workspace:*"
  }
}
```

```json
{
  "dependencies": {
    "pg-hybrid-rag": "file:../rag"
  }
}
```

**Prerequisites:**
- **Node.js 18+** or **Bun 1.0+**
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
const chunker = new Chunker({ tokenLimit: 512, overlap: 75 });
const chunks = chunker.chunk(text, { name: "Product Name", language: "en" });
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
  languages?: string[],            // filter by document language (omit for cross-language)
  minRelevance?: number,           // 0-1, drop below top * threshold
  language?: string,               // for FTS stemming + keyword search (default: "en")
  normalizer?: { normalize(text, lang): string },
  rerank?: boolean,                // default: false
  rerankerMinScore?: number,       // default: 0.01
});
```

#### Search pipeline flow

The search pipeline processes a query through these stages in order:

1. **Normalize** — lowercase, strip trailing punctuation, optionally expand abbreviations via `normalizer`
2. **Remove stop words** — drop common words (loaded per-tenant from `rag_stop_words`) so they don't dilute search
3. **Embed + load synonyms** — run in parallel: embed the cleaned query and load tenant synonyms
4. **3-way hybrid search** — run vector, keyword (pg_trgm), and FTS (tsvector) searches concurrently against Postgres
5. **RRF fusion** — merge the three ranked lists into one using Reciprocal Rank Fusion
6. **Relevance cutoff** — optionally drop results scoring below a fraction of the top result
7. **Rerank** — optionally re-score with a cross-encoder for final ordering

#### Search options explained

| Option | Default | What it does |
|--------|---------|-------------|
| `topK` | `5` | Number of final results to return. Also controls how many candidates each search leg fetches (`topK * candidateMultiplier`). |
| `vectorMinScore` | `0.8` | Minimum cosine similarity for the vector search leg. Chunks below this threshold are excluded before RRF. Higher values mean stricter semantic matching — raise if you get too many loosely related results, lower if relevant results are being missed. |
| `keywordMinScore` | `0.35` | Minimum `word_similarity` score for the pg_trgm keyword leg (or `bigm_similarity` for CJK). Controls fuzzy character-overlap matching. Lower than vectorMinScore because trigram similarity scores are naturally lower than cosine similarity. |
| `vectorWeight` | `1` | Weight multiplier for the vector leg in RRF fusion. Setting to `2` makes semantic matches count twice as much as the other legs. Set to `0` to disable vector search entirely. |
| `keywordWeight` | `1` | Weight multiplier for the keyword (pg_trgm) leg in RRF fusion. Useful for queries where exact character overlap matters (product names, SKUs, codes). |
| `ftsWeight` | `1` | Weight multiplier for the full-text search leg in RRF fusion. FTS uses Postgres stemming, so "running shoes" matches "run shoe". Boost this for natural-language queries where morphological matching helps. |
| `rrfK` | `60` | Smoothing constant in the RRF formula: `score = weight / (rrfK + rank)`. Higher values flatten score differences between ranks (all results score similarly). Lower values amplify the gap between top-ranked and lower-ranked results. `60` is the standard value from the original RRF paper. |
| `sourceTypes` | — | Filter results to specific source types (e.g. `["product", "article"]`). Applied as a SQL WHERE clause before search, not post-filter. |
| `sourceIds` | — | Filter results to specific source IDs. Useful for scoping search to a known set of documents. |
| `languages` | — | Filter results to specific document languages (e.g. `["en", "hi"]`). Applied as a SQL WHERE clause in all three search legs. Omit for cross-language search (default). |
| `minRelevance` | — | Fraction of the top result's RRF score used as a floor (0–1). For example, `0.5` drops any result scoring below 50% of the best result. Applied after RRF fusion but before reranking. |
| `language` | `"en"` | Language code for FTS stemming (Postgres `regconfig`) and keyword search. Accepts short codes (`en`) or BCP-47 (`en-US`). Determines which Postgres stemmer is used — e.g. `english` stems "running" → "run", while `simple` does lowercase-only tokenization. |
| `normalizer` | — | Optional pre-processing hook called before stop-word removal. Receives the cleaned query and language. Useful for expanding abbreviations (e.g. "dept" → "department") or domain-specific normalization. |
| `rerank` | `false` | Enable cross-encoder reranking after RRF fusion. A cross-encoder scores each query-document pair jointly, which is more accurate than the independent scoring of the three search legs, but slower. Requires a `RerankerProvider` on the pipeline. If the reranker throws, results gracefully fall back to RRF order. |
| `rerankerMinScore` | `0.01` | Absolute score floor for reranked results. Results below this cross-encoder score are dropped. Only applies when reranking is active. |

#### Tuning tips

- **Precision over recall**: raise `vectorMinScore` and `keywordMinScore`, add `minRelevance: 0.5`
- **Recall over precision**: lower `vectorMinScore` to `0.6`, `keywordMinScore` to `0.2`, increase `topK`
- **Exact-match heavy** (product search, codes): set `keywordWeight: 2` or `ftsWeight: 2`
- **Semantic-heavy** (natural language questions): set `vectorWeight: 2`
- **Disable a leg**: set its weight to `0` (e.g. `ftsWeight: 0` to skip full-text search)

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

Indexing is upsert-style: calling `index` for an existing `sourceType + sourceId` deletes old chunks before inserting new ones. All chunks are embedded in a single batched call and inserted in a single SQL `INSERT`.

### Chunk

```typescript
// Character-based (original API, backwards compatible)
const chunker = new Chunker(maxSize?, overlap?);
const chunks = chunker.chunk(text, metadata?);

// Token-limit mode (recommended) — computes char limit per language
const chunker = new Chunker({ tokenLimit: 512, overlap: 75 });
const chunks = chunker.chunk(text, { language: "en", name: "Product" });
```

#### Character-based mode

| Parameter | Default | What it does |
|-----------|---------|-------------|
| `maxSize` | `512` | Maximum chunk size in characters. The chunker splits by paragraphs first, then sentences, then fixed-size. |
| `overlap` | `75` | Characters from the end of one chunk prepended to the next, aligned to the nearest word boundary. Provides context continuity across chunk boundaries. |

#### Token-limit mode

When constructed with `{ tokenLimit }`, the chunker computes an effective character limit per language using heuristic chars-per-token ratios with a 0.8 safety margin. This produces denser chunks that better utilize the embedding model's context window while staying safely under the token limit.

| Parameter | Default | What it does |
|-----------|---------|-------------|
| `tokenLimit` | — | Max tokens per chunk. The effective character limit is `tokenLimit × charsPerToken × 0.8`, varying by language. |
| `overlap` | `75` | Same as character-based mode — overlap is always in characters. |

Pass `language` in the metadata to activate language-aware sizing:

| Language | Codes | Chars/token | Effective limit (512 tokens) |
|----------|-------|-------------|------------------------------|
| English, Spanish, French, German, Italian, Portuguese, Romanian, Malay | `en`, `es`, `fr`, `de`, `it`, `pt`, `ro`, `ms` + BCP-47 | ~4 | 1638 chars |
| Hindi | `hi` + BCP-47 | ~3 | 1228 chars |
| Arabic | `ar` + BCP-47 | ~3 | 1228 chars |
| Sinhalese | `si` + BCP-47 | ~3 | 1228 chars |
| Chinese, Japanese, Korean | `zh`, `ja`, `ko` + BCP-47 | ~1.5 | 614 chars |
| Unknown | any other | 1 | 512 chars |

If `metadata` contains a `name` field (and optionally `brand`), each chunk is automatically prefixed with `[Name | Brand]` so the embedding model knows which entity the chunk belongs to.

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

The `sql/` directory is auto-detected on all Node versions (18+) and module formats (ESM and CJS). If auto-detection fails, pass `sqlDir` explicitly:

```typescript
await ragMigrate(sqlClient, { sqlDir: "/path/to/node_modules/pg-hybrid-rag/sql" });
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

interface ChunkingProvider {
  chunk(text: string, metadata?: Record<string, string>): Chunk[];
}
```

### Custom Chunker Example (Chonkie)

The built-in `Chunker` implements `ChunkingProvider`. To use a different chunking library, wrap it to match the interface:

```typescript
import { RecursiveChunker } from "@chonkiejs/core";
import type { ChunkingProvider } from "pg-hybrid-rag";

// Pre-create the async chunker once
const chonkie = await RecursiveChunker.create({ chunkSize: 512 });

const chunker: ChunkingProvider = {
  chunk(text, metadata = {}) {
    // chonkie returns { text, tokenCount }[] — map to Chunk[]
    const result = chonkie.chunkSync(text);
    return result.map((c, i) => ({
      content: c.text,
      index: i,
      metadata,
    }));
  },
};

// Use with the indexer like any other chunker
const chunks = chunker.chunk(productText, { name: "Product", language: "en" });
await indexer.index("product", productId, chunks, "en");
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
- **OpenAiCompatibleEmbedder** — fetch-based, works in Node + Bun; supports `batchSize` and `concurrency` for batched embedding. See [`examples/docker-compose.yml`](examples/docker-compose.yml) for running a self-hosted embedding API with HuggingFace TEI.
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

---

Built entirely by AI using [Claude Code](https://claude.ai/claude-code).
